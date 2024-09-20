const fs = require("fs-extra");
const path = require("node:path");
const core = require("@livestreamer/core");
const utils = require("@livestreamer/core/utils");
const DataNode = require("@livestreamer/core/DataNode");

const log_interval = 1 * 1000;

class Upload extends DataNode {
    #last_log = 0;
    segment_tree = new utils.RangeTree();
    /** @type {Set<import("fs").WriteStream>} */
    streams = new Set();
    #speeds = [];
    #last_ts;
    #last_bytes;
    #speed_pointer=0;
    /** @type {utils.Interval} */
    #speed_check_interval;

    get finished() { return this.$.bytes >= this.$.total; }
    get bytes() { return this.$.bytes; }
    // get segments() { return this.$.segments; }
    get unique_dest_path() { return this.$.dest_path; }
    get status() { return this.$.status; }
    get filesize() { return this.$.total; }
    get chunks() { return this.$.chunks; }
    get first_and_last_chunks_uploaded() { return this.segment_tree.includes(0) && this.segment_tree.includes(this.filesize-1); }
    get first_chunk_uploaded() { return this.segment_tree.includes(0); }

    static Status = {
        STARTED:1,
        FINISHED:2,
        CANCELED:3,
        ERROR:4,
    }

    constructor(id, dest_path, filesize, mtime=0) {
        super(id);

        this.$.bytes = 0;
        this.$.total = filesize;
        this.$.speed = 0;
        this.$.dest_path = dest_path;
        this.$.status = Upload.Status.STARTED;
        this.$.chunks = 0;
        this.mtime = mtime;

        var dir = path.dirname(dest_path);
        // var hash = utils.md5(JSON.stringify([filesize, mtime]));
        // var chunks_dir = path.join(dir, `.chunks`);
        // this.chunk_file_path = path.join(chunks_dir, `${this.id}.json`);
        // this.chunk_file_path = path.join(dir, `.chunks_${hash}`);

        app.uploads[id] = this;
        app.$.uploads[id] = this.$;
        core.logger.info(`Starting upload '${this.unique_dest_path}'...`);

        this.ready = (async ()=>{
            await fs.mkdir(dir, {recursive:true});
            // await fs.mkdir(chunks_dir, {recursive:true});
            this.$.dest_path = await utils.unique_filename(dest_path);
            if (dest_path !== this.unique_dest_path) {
                core.logger.info(`Upload (${dir}) '${path.basename(dest_path)}' -> '${path.basename(this.unique_dest_path)}'...`);
            }

            // this should force the file to be written sequentially even if chunks arrive out of order by reserving the space on disk first.
            // await utils.reserve_disk_space(this.unique_dest_path, filesize);

            await fs.writeFile(this.unique_dest_path, "\0");

            this.#last_log = Date.now();
            
            this.$.status = Upload.Status.STARTED;

            this.#speed_check_interval = new utils.Interval(()=>{
                var ts = Date.now();
                let speed = Math.round((this.bytes - this.#last_bytes)/((ts - this.#last_ts)/1000)) || 0;
                this.#speeds[(this.#speed_pointer++)%8] = speed;
                this.$.speed = utils.average(this.#speeds);
                this.#last_ts = ts;
                this.#last_bytes = this.bytes;
            }, 1000);
        })();
    }

    /** @param {import("stream").Readable} stream */
    add_chunk(stream, start, oncomplete) {
        var writestream = fs.createWriteStream(this.unique_dest_path, {start, flags: "r+"}); // stat?"r+":"w"
        var p = start;
        this.streams.add(writestream);
        stream.on("data", (chunk)=>{
            var ts = Date.now();
            let start = p;
            let end = p + chunk.length;
            this.segment_tree.add(start, end);
            this.$.bytes = this.segment_tree.total;
            // this.$.bytes += chunk.length;
            var percent = this.bytes / this.$.total;
            if ((ts - this.#last_log) > log_interval) {
                this.#last_log = ts;
                core.logger.info(`Uploading ['${this.unique_dest_path}', ${this.bytes}/${this.$.total}, ${(percent*100).toFixed(2)}%`);
            }
            /* if (this.first_last_parts_uploaded && !this.#first_last_parts_uploaded) {
                this.#first_last_parts_uploaded = true;
                this.emit("first_last_parts");
            } */
            p += chunk.length;
        });
        /* stream.on("error", err => {
            debugger;
        }); */
        return new Promise((resolve,reject)=>{
            stream
                .pipe(writestream)
                .on("error", (err)=>{
                    this.$.status = Upload.Status.ERROR;
                    this.streams.delete(writestream);
                    writestream.end();
                    this.emit("error", err);
                    reject(err);
                })
                .on("finish", ()=>{
                    resolve();
                    this.$.chunks++;
                    this.emit("chunk");
                    this.streams.delete(writestream);
                    
                    if (this.finished && this.$.status !== Upload.Status.FINISHED) {
                        this.$.status = Upload.Status.FINISHED;
                        core.logger.info(`Upload finished '${this.unique_dest_path}'`);
                        writestream.on("close", ()=>{
                            // this.sync_mtime();
                            this.emit("complete");
                        });
                    }
                    if (this.status === Upload.Status.FINISHED) {
                        this.destroy();
                    }
                })
        })
    }

    /* async sync_mtime() {
        if (!this.mtime) return;
        var stat = await fs.stat(this.unique_dest_path);
        await fs.utimes(this.unique_dest_path, stat.atime, new Date(this.mtime));
    } */

    /* get first_last_parts_uploaded() {
        var mb = 1024*1024, filesize = this.filesize;
        if (filesize <= mb*2) return true;
        return this.segment_tree.includes(0,mb) && this.segment_tree.includes(filesize - mb, filesize);
    } */
    async cancel() {
        if (this.$.status === Upload.Status.CANCELED) return;
        this.$.status = Upload.Status.CANCELED;
        for (var s of this.streams) {
            s.close();
            // await new Promise(resolve=>s.destroy(resolve));
        }
        setTimeout(()=>{
            this.destroy();
        }, 60*1000);
    }
    destroy() {
        delete app.uploads[this.id];
        this.#speed_check_interval.destroy();
        super.destroy();
    }
}

module.exports = Upload;

const app = require(".");