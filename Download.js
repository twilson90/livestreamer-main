const execa = require("execa");
const path = require("node:path");
const os = require("node:os");
const fs = require("fs-extra");
const tree_kill = require("tree-kill");
const readline = require("node:readline");
const core = require("@livestreamer/core");
const utils = require("@livestreamer/core/utils");
const DataNode = require("@livestreamer/core/DataNode");

const log_interval = 5 * 1000;

class Download extends DataNode {
    get filename() { return this.$.filename; };
    get promise() { return this.#promise; };
    #promise = null;
    #cancel = null;
    #last_log = 0;
    
    constructor(id, filename, dest_dir) {
        super(id);
        app.downloads[this.id] = this;
        app.$.downloads[this.id] = this.$;

        this.dest_dir = dest_dir || app.files_dir;
        this.$.filename = filename;
    }

    start() {
        if (!this.#promise) {
            this.#promise = new Promise(async (resolve,reject)=>{
                this.$.bytes = 0;
                this.$.total = 0;
                this.$.speed = 0;
                var mi = await app.probe_media(this.filename);

                if (mi.probe_method != "youtube-dl") return;
                
                var name = mi.filename
                var dest_path = path.join(this.dest_dir, name);
                this.$.dest_path = dest_path;
                var exists = await fs.stat(dest_path).catch(()=>{});
                var fail;
                if (exists) {
                    core.logger.info(`'${this.filename}' already exists.`);
                } else {
                    core.logger.info(`Starting download '${this.filename}'...`);
                    this.$.stage = 0;
                    this.$.num_stages = 1;
                    var tmp_download_path = path.join(os.tmpdir(), name)
                    var proc = execa(core.conf["main.youtube_dl"], [
                        this.filename,
                        "--no-warnings",
                        "--no-call-home",
                        "--no-check-certificate",
                        // "--prefer-free-formats", // this uses MKV on ubuntu...
                        // "--extractor-args", `youtube:skip=hls,dash,translated_subs`,
                        `--format`, core.conf["main.youtube_dl_format"],
                        `--no-mtime`,
                        "--output", tmp_download_path
                    ]);
                    this.#cancel = ()=>tree_kill(proc.pid, 'SIGINT');
                    this.stdout_listener = readline.createInterface(proc.stdout);
                    // this.stderr_listener = readline.createInterface(proc.stderr);
                    var first = false;
                    // var last_bytes = 0, last_ts = 0;
                    this.stdout_listener.on("line", line=>{
                        var m;
                        // console.log(line);
                        if (line.match(/^\[download\] Destination\:/i)) {
                            if (first) this.$.stage++;
                            if (this.$.stage >= this.$.num_stages) this.$.num_stages = this.$.stage+1;
                            first = true;
                        } else if (m = line.match(/^\[download\]\s+(\S+)\s+of\s+(\S+)\s+at\s+(\S+)\s+ETA\s+(\S+)/i)) {
                            var percent = parseFloat(m[1]) / 100;
                            this.$.total = Math.floor(utils.string_to_bytes(m[2]));
                            this.$.bytes = Math.floor(percent * this.$.total);
                            this.$.speed = Math.floor(utils.string_to_bytes(m[3]));
                            var now = Date.now();
                            // last_bytes = this.$.bytes;
                            // last_ts = now;

                            if ((now - this.#last_log) > log_interval) {
                                this.#last_log = now;
                                this.emit("info", `Downloading '${this.filename}', ${this.$.bytes}/${this.$.total}, ${(percent*100).toFixed(2)}%, ${utils.format_bytes(this.$.speed)}ps...`)
                            }
                        } else if (line.match(/^ERROR\:/i)) {
                            this.emit("error", line);
                            // core.logger.error(`[download] ${line}`)
                        }
                    });
                    /* this.stderr_listener.on("line", line=>{
                        console.log(line)
                    }); */

                    await proc.then(async ()=>{
                        await fs.rename(tmp_download_path, dest_path);
                        core.logger.info(`Download finished [${this.filename}]`);
                    }).catch(e=>{
                        core.logger.error(e);
                        core.logger.warn(`Download [${this.filename}] interrupted.`);
                        fail = true;
                    })
                }

                if (fail) reject();
                else resolve(dest_path);
                    
                this.#cancel = null;
                this.destroy();
            });
        }
        return this.#promise;
    }

    cancel() {
        if (this.#cancel) this.#cancel();
    }

    destroy() {
        this.cancel();
        super.destroy();
        delete app.downloads[this.id];
        if (this.stdout_listener) this.stdout_listener.close();
        if (this.stderr_listener) this.stderr_listener.close();
        this.stdout_listener = null;
        this.stderr_listener = null;
        this.#promise = null;
        this.#cancel = null;
        this.emit("destroy");
    }
}

module.exports = Download;

const app = require(".");