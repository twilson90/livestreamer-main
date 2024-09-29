import fs from "fs-extra";
import path from "node:path";
import { core, utils, PropertyCollection } from "@livestreamer/core";
import { SessionBase, Download, app } from "./internal.js";

const video_exts = ["3g2","3gp","aaf","asf","avchd","avi","drc","flv","gif","m2v","m4p","m4v","mkv","mng","mov","mp2","mp4","mpe","mpeg","mpg","mpv","mxf","nsv","ogg","ogv","qt","rm","rmvb","roq","svi","vob","webm","wmv","yuv"];

const VERSION = 3.0;

class InternalSession extends SessionBase {
    #last_tick = Date.now();
    #ticks = 0;
    #last_save_data;
    #autosaves = [];
    #playlist_update_ids = new Set();
    #playlist_info = {};
    #updating = false;

    get save_dir() { return path.join(app.curr_save_dir, this.id); }
    get files_dir() { return this.$.files_dir ? this.$.files_dir : app.files_dir; }

    get rtmp_key_without_args() { return this.$.rtmp_key.split("?")[0]; }

    get mpv() { return (this.stream||{}).mpv; }
    get is_running() { return !!(this.stream||{}).is_running; }

    constructor(id, name) {
        super(id, name);

        this.$.__version__ = VERSION;
        
        fs.mkdirSync(this.save_dir, {recursive:true});
        fs.mkdirSync(this.files_dir, {recursive:true});

        var media_props = new Set(["background_file", "files_dir"])

        utils.Observer.listen(this.$, c=>{
            // if (!c.nested) { }
            /* if (!(c.path[0] in PROPS)) {
                core.logger.error(`Property '${c.path[0]}' is not defined.`);
            } */
            // need to determine if this prop is to be sent to lua script.
            /* if (PROPS[c.path[0]] && PROPS[c.path[0]].lua !== false) {
                this.lua_message("update_value", c.path, c.new_value);
            } */
            if (c.path[0] === "playlist") {
                if (c.path[1]) {
                    this.#playlist_update_ids.add(c.path[1]);
                }
                if (c.path[2] == "filename" && c.new_value) {
                    this.#handle_filename_add_or_change(c.path[1])
                }
                this.#debounced_update_playlist_info_after_changes();
                if (this.#updating && c.path[2] === "props" && c.path[3] === "playlist_mode" && c.new_value == 2) {
                    this.fix_2_track_playlist(c.path[1]);
                }
            } else if (media_props.has(c.path[0])) {
                app.unregister_media_ref(c.old_value);
                app.register_media_ref(c.new_value);
            }
        });

        // if (!this.$.rtmp_key) this.generate_rtmp_key();
    }

    async #handle_filename_add_or_change(id){
        var item = this.get_playlist_item(id);
        if (!item) return;

        var filename = item.filename;
        var mi = await app.probe_media(filename);

        // if playlist is already full of items, ignore.
        if (!mi.playlist || this.get_playlist_items(id).length) return;

        // handles mediainfo playlists
        var pos = 0;
        var all = new Set([...mi.playlist]);
        for (let filename of mi.playlist) {
            if (typeof filename !== "string") continue;
            all.delete(filename);
            this.#playlist_add({filename:filename, index:pos++, parent_id:id})
        }
        if (all.size) {
            var add_children = (items, new_parent_id)=>{
                items.sort((a,b)=>a.index-b.index);
                for (var item of items) {
                    all.delete(item);
                    item.index = pos++;
                    item.parent_id = new_parent_id;
                    var new_item = this.#playlist_add(item);
                    var children = [];
                    if (item.id) children.push(...[...all].filter(f=>f.parent_id == item.id));
                    if (item.children) children.push(...item.children); // for json playlists with children variable tree-like structure.
                    if (children.length) {
                        add_children(children, new_item.id);
                    }
                }
            }
            add_children([...all].filter(f=>!f.parent_id || f.parent_id == "0"), id);
            // add any leftovers if there was a fuck up:
            if (all.size) {
                this.logger.warn(`Leftover playlist items detected and added: ${JSON.stringify([...all])}`);
                add_children([...all], id);
            }
        }
    }
    async update_media_info_from_ids(ids, force=true) {
        // this does it in order of playlist items...
        ids = ids.map(id=>[id, ...this.get_playlist_items(id, null, true).map(i=>i.id)]).flat();
        var filenames = {};
        for (var id of ids) {
            var info = await this.get_playlist_info(id);
            if (info) {
                for (var f of info.filenames) {
                    if (!filenames[f]) app.probe_media(f, {force});
                    filenames[f] = 1
                }
            }
        }
    }

    fix_2_track_playlist(id) {
        for (var item of this.get_playlist_items(id)) {
            var ext = path.extname(item.filename);
            item.track_index = ext.match(/^\.(aa|aac|aax|act|aiff|alac|amr|ape|au|awb|dss|dvf|flac|gsm|iklax|ivs|m4a|m4b|m4p|mmf|movpkg|mp3|mpc|msv|nmf|ogg|oga|mogg|opus|ra|rm|raw|rf64|sln|tta|voc|vox|wav|wma|wv|8svx|cda)$/i) ? 1 : 0;
        }
        this.#playlist_update_indices()
    }

    async #update_playlist_info(id) {
        var old_filenames = new Set((await this.#playlist_info[id]||{}).filenames||[]);

        if (!(id in this.$.playlist)) {
            old_filenames.forEach(filename=>app.unregister_media_ref(filename));
            delete this.#playlist_info[id];
            delete this.$.playlist_info[id];
            delete this.$.detected_crops[id];
            return;
        }

        return this.#playlist_info[id] = (async ()=>{
            var item = this.$.playlist[id];
            var props = item.props || {};

            var new_filenames = new Set();
            if (item.filename) new_filenames.add(item.filename);
            if (props) {
                if (props.background_file) new_filenames.add(props.background_file);
                if (props.audio_file) new_filenames.add(props.audio_file);
                if (props.subtitle_file) new_filenames.add(props.subtitle_file);
            }
            var added_filenames = [...utils.set_difference(new_filenames, old_filenames)];
            var removed_filenames = [...utils.set_difference(old_filenames, new_filenames)];
            added_filenames.forEach(filename=>app.register_media_ref(filename));
            removed_filenames.forEach(filename=>app.unregister_media_ref(filename));

            if (!this.$.playlist_info[id]) this.$.playlist_info[id] = {};
            
            var info = {
                filenames: [...new_filenames],
            };
            // if (app.proxy_files[item.filename]) {
            //     info.proxy_filename = app.proxy_files[item.filename];
            // }
            utils.deep_sync(this.$.playlist_info[id], info);

            return info;
        })();
    }

    #debounced_update_playlist_info_after_changes = utils.debounce(()=>this.#update_playlist_info_after_changes());

    async #update_playlist_info_after_changes() {
        var ids = [...this.#playlist_update_ids];
        this.#playlist_update_ids.clear();
        await Promise.all(ids.map(id=>this.#update_playlist_info(id)));
    }

    async #playlist_update_indices() {
        Object.values(utils.group_by(Object.values(this.$.playlist), i=>`${i.parent_id},${i.track_index}`)).forEach(items=>{
            utils.sort(items, item=>item.index).forEach((item,i)=>item.index = i);
        });
    }

    async scheduled_start_stream() {
        this.logger.info(`Scheduled to start streaming now...`);
        await this.start_stream();
        this.$.schedule_start_time = null;
        // core.emit("session.scheduled-start", this.id);
        core.ipc.emit("main.session.scheduled-start", this.$);
    }

    async tick() {
        var now = Date.now();
        var start_time = +new Date(this.$.schedule_start_time);
        if (start_time && now >= start_time && this.#last_tick < start_time) {
            this.scheduled_start_stream();
        }
        if (this.#ticks % 60 == 0) {
            this.prepare_next_playlist_item();
        }
        this.#last_tick = now;
        this.#ticks++;
    }
    
    prepare_next_playlist_item() {
        var next = this.playlist_get_next_item();
        if (next && next.filename) {
            return app.prepare(next.filename);
        }
    }

    async destroy(move_autosave_dir=false) {
        await this.stop_stream();
        if (move_autosave_dir) {
            await fs.rename(this.save_dir, path.join(app.old_save_dir, this.id)).catch(()=>{});
        }
        return super.destroy();
    }

    async download_and_replace(ids) {
        if (!Array.isArray(ids)) ids = [ids];
        var playlist_ids = [];
        
        ids = ids.map(id=>{
            var playlist = this.get_playlist_items(id);
            if (playlist.length) playlist_ids.push(id);
            return playlist.length ? playlist.map(item=>item.id) : id;
        }).flat();
        
        for (var id of playlist_ids) {
            var filename = this.$.playlist[id].filename;
            var mi = await app.probe_media(filename);
            this.$.playlist[id].filename = "livestreamer://playlist";
            this.$.playlist[id].props["name"] = mi.name;
        }
        
        for (let id of ids) {
            var filename = (this.get_playlist_item(id) || {}).filename;
            var mi = (await app.probe_media(filename)) || {};
            if (!mi.downloadable) continue;
            if (app.downloads[id]) continue;
            var download = new Download(id, filename, this.files_dir, );
            download.on("error", (msg)=>this.logger.error(msg));
            download.on("info", (msg)=>this.logger.info(msg));
            var filename = await download.start().catch((e)=>{
                if (!e) this.logger.warn(`Download '${filename}}' was cancelled.`);
                else if (e.message && e.message.startsWith("Command failed with exit code 1")) this.logger.warn(`Download '${filename}}' was cancelled.`)
                else if (e.stderr) this.logger.error(e.stderr);
                else this.logger.error(e);
            });
            if (filename) {
                var item = this.$.playlist[id];
                if (item) item.filename = filename;
            }
        }
    }

    async cancel_download(ids) {
        if (!Array.isArray(ids)) ids = [ids];
        for (var id of ids) {
            var download = app.downloads[id];
            if (download) download.cancel();
        }
    }

    async cancel_upload(ids) {
        if (!Array.isArray(ids)) ids = [ids];
        for (var id of ids) {
            var upload = app.uploads[id];
            if (upload) upload.cancel();
        }
    }

    /* async create_playlist(ids) {
        if (!Array.isArray(ids)) ids = [ids];
        var items = ids.map(id=>this.$.playlist[id]);
        items.sort((a,b)=>a.index-b.index);
        var new_item = this.playlist_add("livestreamer://playlist", items[0].index, items[0].parent_id, items[0].track_index);
        items.forEach((item,i)=>{
            item.parent_id = new_item.parent_id;
            item.index = i;
            item.track_index = 0;
        })
        this.update_playlist_indices();
        return new_item;
    } */

    async detect_crop(ids) {
        if (!Array.isArray(ids)) ids = [ids];
        for (var id of ids) {
            var item = this.$.playlist[id];
            if (!item) continue;
            var filename = item.filename;
            var mi = await app.probe_media(filename) || {};
            if (mi.probe_method !== "ffprobe") continue;
            if (mi.protocol !== "file:") continue;
            var v_stream = mi.streams.find(c=>c.type==="video");
            if (!v_stream) continue;
            var [w, h] = [+v_stream.width, +v_stream.height];
            this.logger.info(`Running crop detection on '${filename}'...`);
            var t0 = Date.now();
            var n = 5; // num keyframes to sample.
            var props = item.props || {};
            var start = props.clip_start || 0;
            var end = Math.min(props.clip_end || Number.MAX_SAFE_INTEGER, +mi.duration);
            var duration = end-start;
            duration -= duration/n;
            start += duration/n/2;

            var filepath = utils.try_file_uri_to_path(filename);
            var hash = `${utils.md5(filepath)}-${new Date().toISOString().replace(/[^\d]+/g,"")}`;
            var dir = path.join(app.screenshots_dir, hash);
            fs.mkdirSync(dir, {recursive:true});
            var r = (n/duration).toFixed(5);
            var vfs = [
                `cropdetect=limit=24:round=2:reset_count=1`, //skip=0: // skip is not available on server, by default it skips first 2 frames (wtf? booo!)
                `scale=trunc(ih*dar/2)*2:trunc(ih/2)*2`,
                `setsar=1/1`
            ];
            var proc = await utils.execa(core.conf["core.ffmpeg_executable"], ["-skip_frame", "nokey", '-noaccurate_seek', "-ss", start, "-i", filepath, "-max_muxing_queue_size","9999", "-vf", vfs.join(","), "-vsync", "0", "-vframes", String(n), "-y", `%04d.jpg`], {cwd: dir});
            var files = await fs.readdir(dir);
            
            var lines = proc.stderr.split(/\r?\n/);
            var rects = [];
            for (var line of lines) {
                var m = line.match(/crop=(.+?):(.+?):(.+?):(.+?)$/);
                if (m) {
                    console.log(m[0])
                    var rect = new utils.Rectangle(+m[3],+m[4],+m[1],+m[2]);
                    rect.scale(1/w,1/h);
                    if (rect.width < 0 || rect.height < 0) rect = new utils.Rectangle(0,0,1,1);
                    rects.push(rect);
                }
            }
            var t1 = Date.now();
            this.logger.info(`Crop detection found ${combined_rect} in ${(t1-t0)/1000} secs`);
            if (rects.length) {
                var crop_data = files.slice(0, n).map((f,i)=>{
                    var url = `screenshots/${hash}/${f}`;
                    var rect = rects[Math.min(i,rects.length-1)].toJSON();
                    return {url, rect}
                });
                this.$.detected_crops[id] = crop_data;
                var combined_rect = utils.Rectangle.union(...rects);

                Object.assign(this.$.playlist[id].props, {
                    "crop_left": combined_rect.left,
                    "crop_top": combined_rect.top,
                    "crop_right": 1-combined_rect.right,
                    "crop_bottom": 1-combined_rect.bottom,
                });
            }
        }
    }

    get_current_playlist_item() {
        return this.$.playlist[this.$.playlist_id];
    }

    get_adjacent_playlist_item(id, inc=1, skip_playlist=true) {
        var curr = this.get_playlist_item(id);
        var playlist = this.get_flat_playlist("0", skip_playlist);
        var index = playlist.indexOf(curr) + inc; // , 0, playlist.length-1);
        return playlist[index];
    }

    get_playlist_info(id) {
        return this.#playlist_info[id] || this.#update_playlist_info(id);
    }

    /** @return {any[]} */
    get_playlist_items(parent_id="0", track_index=null, recursive=false) {
        var items = [];
        var children = Object.values(this.$.playlist).filter(i=>i.parent_id == parent_id && (track_index == null || i.track_index == track_index));
        children.sort((a,b)=>a.track_index-b.track_index || a.index-b.index);
        for (var item of children) {
            items.push(item);
            if (recursive) items.push(...this.get_playlist_items(item.id, null, true));
        }
        return items;
    }

    get_playlist_tracks(parent_id="0") {
        var item = this.get_playlist_item(parent_id);
        var tracks = [];
        if (item.props.playlist_mode == 2) {
            for (var i = 0; i<2; i++) tracks.push([...this.get_playlist_items(parent_id, i)]);
        } else {
            tracks[0] = [...this.get_playlist_items(parent_id)];
        }
        return tracks;
    }

    get_playlist_parents(id) {
        var item = this.$.playlist[id];
        var parents = [];
        while(item) {
            item = this.$.playlist[item.parent_id];
            if (item) parents.push(item);
        }
        return parents;
    }

    get_playlist_item(id) {
        return this.$.playlist[id];
    }

    playlist_clear() {
        utils.clear(this.$.playlist);
    }
    
    
    #playlist_add(f) {
        if (typeof f !== "object") f = {filename:String(f)};
        var {id, filename, props, index, parent_id, track_index} = f; // , upload_id
        id = String(f.id || utils.uuidb64());
        while (this.$.playlist[id]) id = utils.uuidb64();
        filename = filename || "livestreamer://empty";
        props = props || {};
        index = index == null ? this.get_playlist_items(parent_id, track_index).length : +index;
        parent_id = String(parent_id) || "0";
        track_index = track_index || 0;

        var item = {id, filename, props, index, parent_id, track_index};

        this.$.playlist[id] = item;

        return item;
    }

    playlist_add(files, insert_pos=null, parent_id="0", track_index=0) {
        if (!Array.isArray(files)) files = [files];
        var results = [];
        if (!(parent_id in this.$.playlist)) parent_id = "0";
        var playlist = this.get_playlist_items(parent_id, track_index);
        if (insert_pos == null) insert_pos = playlist.length;
        insert_pos = utils.clamp(insert_pos, 0, playlist.length);
        var playlist_after = playlist.slice(insert_pos);

        files = files.map(f=>(!f || typeof f == "string") ? {filename:f} : {...f})
        var playlist_map = utils.group_by(files, f=>f.parent_id || parent_id);

        var walk = (map_key, parent_id, index)=>{
            if (!playlist_map[map_key]) return;
            playlist_map[map_key].forEach((f,i)=>{
                f.index = index + i;
                f.parent_id = parent_id;
                var new_item = this.#playlist_add(f);
                results.push(new_item);
                walk(f.id, new_item.id, 0);
            });
            delete playlist_map[map_key];
        }

        var num_added = (playlist_map[parent_id] || []).length;
        walk(parent_id, parent_id, insert_pos);
        insert_pos += num_added;
        Object.keys(playlist_map).forEach(id=>walk(id, "0", insert_pos++));

        playlist_after.forEach((item,i)=>item.index = insert_pos++);
        this.#playlist_update_indices(); // <-- shouldn't be necessary but calling it just in case...

        return results;
    }
    
    #playlist_remove(id) {
        this.cancel_download(id);
        this.cancel_upload(id);
        this.get_playlist_items(id).forEach(c=>this.#playlist_remove(c.id));
        delete this.$.playlist[id];
    }

    playlist_remove(ids) {
        if (!Array.isArray(ids)) ids = [ids];
        for (var id of ids) this.#playlist_remove(id);
        this.#playlist_update_indices();
    }
    
    get_flat_playlist(id, skip_playlist=true) {
        var items = [];
        for (var c of this.get_playlist_items(id)) {
            items.push(c);
            if (!skip_playlist || !c.props.playlist_mode) {
                items.push(...this.get_flat_playlist(c.id, skip_playlist));
            }
        }
        return items;
    }

    playlist_update(data) {
        for (var k of Object.keys(data)) {
            if (!(k in this.$.playlist)) delete data[k];
        }
        if (utils.is_circular(Object.values(data).map(({id, parent_id: parent})=>({id,parent})))) {
            throw new Error(`Detected circular parent-child loop`);
        }
        this.#updating = true;
        utils.deep_merge(this.$.playlist, data, true);
        this.#playlist_update_indices();
        this.#updating = false;
    }

    reset_playlist_props(ids) {
        if (!Array.isArray(ids)) ids = [ids];
        for (var id of ids) {
            var item = this.$.playlist[id];
            if (item) item.props = {};
        }
    }

    /* async get_merged_playlist_root(id) {
        for (var p of this.get_playlist_parents(id)) {
            if (p.props["playlist-mode"]) return p;
        }
    } */

    get_user_save_data() {
        return this.fix_data(this.$);
    }

    async client_load_autosave(filename) {
        // this.autosave();
        var data = JSON.parse(await fs.readFile(path.join(this.save_dir,filename),"utf8"));
        await this.load(data);
    }

    async load(data, full=false) { // full aka init (only true when App is loading)
        this.logger.info(`Loading... [full=${full}]`);
        data = this.fix_data(data, true);
        this.#last_save_data = data;
        
        delete data.id;
        if (!full) {
            delete data.index;
            delete data.name;
            delete data.access_control;
        }
        
        delete data.uploads;
        delete data.downloads;
        if (data.stream) {
            data.stream.state = "stopped";
        }

        for (var k in data) {
            this.$[k] = PROPS.__get_default(k);
            if (typeof this.$[k] === "object" && typeof data[k] === "object" && this.$[k] !== null && data[k] !== null) Object.assign(this.$[k], data[k]);
            else this.$[k] = data[k];
        }
        this.#fix_circular();
        this.#playlist_update_indices();

        if (full) {
            this.#autosaves = (await utils.readdir_stats(this.save_dir).catch(()=>[])).sort((a,b)=>a.stat.mtime-b.stat.mtime).map(f=>f.filename);
        }
        // this.autosave();
    }

    #fix_circular() {
        var ids = utils.detect_circular_structure(Object.values(this.$.playlist).map(({id,parent_id:parent})=>({id,parent})));
        if (ids.length) {
            this.logger.error(`Found circular parent-child loops in playlist, attempting to fix:`, ids.join(", "))
            for (var id of ids) this.$.playlist[id].parent_id = "0";
        }
    }
    
    async autosave() {
        var data = this.fix_data(this.$);
        var diff = save_diff(data, this.#last_save_data);
        this.#last_save_data = data;
        if (utils.is_empty(diff)) return;

        /* var diff_list = utils.deep_entries(diff, true, (k,v)=>{
            return !(v instanceof utils.Diff);
        }); */
        
        var filename = `${utils.sanitize_filename(this.name)}-${utils.date_to_string()}`;
        
        delete diff.time;

        if (utils.is_empty(diff) && this.#autosaves.length) {
            // if diff only included current_time, just replace previous save file...
            filename = this.#autosaves[this.#autosaves.length-1];
        } else {
            this.logger.info(`Autosaving...`);
            this.#autosaves.push(filename);
        }
        var json = JSON.stringify(data, null, "  ");

        var fullpath = path.join(this.save_dir, filename);
        await fs.writeFile(fullpath, json);
        
        while (this.#autosaves.length > core.conf["main.autosaves_limit"]) {
            await this.delete_save(this.#autosaves.shift());
        }
    }

    async delete_save(filename) {
        var f = path.join(this.save_dir, filename);
        try { await fs.unlink(f); } catch { }
    }

    async get_autosave_history() {
        await this.autosave();
        var curr = this.fix_data(this.$);
        var prev;
        var history = [];
        var files = (await utils.readdir_stats(this.save_dir).catch(()=>[])).sort((a,b)=>b.stat.mtime-a.stat.mtime);
        for (var f of files) {
            var data;
            var fullpath = path.join(this.save_dir, f.filename);
            try {
                data = JSON.parse(await fs.readFile(fullpath, "utf8"));
            } catch (e) {
                this.logger.error(`malformed json: '${fullpath}'`);
                continue;
            }
            data = this.fix_data(data);
            var curr_diff = save_diff(curr, data);
            var prev_diff = prev ? save_diff(prev, data) : null;
            [curr_diff, prev_diff].forEach(diff_tree=>{
                utils.deep_walk(diff_tree, function(k,v,path){
                    if (v instanceof utils.Diff) {
                        this[k] = [v.type, v.old_value, v.new_value];
                        return false;
                    }
                    // return true;
                })
            })
            curr_diff = diff_tree_to_list(curr_diff);
            prev_diff = prev_diff ? diff_tree_to_list(prev_diff) : null;
            if (prev_diff && prev_diff.length == 0 || (!prev_diff && curr_diff.length == 0)) continue;
            history.push({
                filename: f.filename,
                mtime: +f.stat.mtime,
                curr: curr_diff,
                prev: prev_diff,
            });
            prev = data;
        }
        return history;
    }
    
    fix_data($, warn) {
        const cleanup_prop = ($, props, delete_criteria) => {
            if (!$) return;
            for (var k of Object.keys($)) {
                if (!props[k]) {
                    if (warn) this.logger.debug(`Unrecognized property '${k}'`);
                }
                if (delete_criteria && delete_criteria(k, $[k], props[k])) {
                    if (warn) this.logger.debug(`Deleting property '${k}'...`);
                    delete $[k];
                }
            }
        }

        $ = utils.deep_copy($);
        
        $.volume_target = utils.clamp($.volume_target, 0, 200);
        if (isNaN($.volume_target)) $.volume_target = 100;

        if (!$.access_control) $.access_control = {};
        app.fix_access_control($.access_control);

        for (var id in $.playlist) {
            var item = $.playlist[id];
            var filename = app.fix_filename(item.filename || "");
            if (filename === "livestreamer://logo") filename = "livestreamer://empty";

            var parent_id = item.parent || item.parent_id;
            if (!parent_id || !(parent_id in $.playlist)) parent_id = "0";
            var props = item.props || item.extra || {};
            var track_index = item.track_index || item.track || 0;
            var index = item.index || 0;
            cleanup_prop(props, PROPS.playlist.enumerable_props.props.props, (k,v,p)=>(v==null) || !p);

            $.playlist[id] = {id,filename,parent_id,index,track_index,props};
        }

        cleanup_prop($, PROPS, (k,v,p)=>(p && p.save === false));
        cleanup_prop($.player_default_override, PLAYER_PROPS, (k,v,p)=>!p || v === p.default || p.save === false);

        return $;
    }

    async seek(time) {
        time = Math.max(0, +time);
        if (isNaN(time)) time = 0;
        if (this.is_running) {
            this.mpv.seek(time)
        } else {
            this.$.time = time;
        }
    }

    async reload() {
        if (this.is_running) await this.mpv.reload(true);
    }

    async playlist_play(id, opts) {
        opts = Object.assign({
            start: 0,
            allow_null: false,
        }, opts);

        var item = this.get_playlist_item(id);

        if (this.is_running && this.is_item_playlist(id) && !item.props.playlist_mode) {
            item = this.get_adjacent_playlist_item(id, 1, true);
        }
        if (id != "-1" && !item && !opts.allow_null) {
            item = this.get_flat_playlist("0", true)[0];
        }
        if (this.is_running && item && item.filename === "livestreamer://exit") {
            var parent = this.get_playlist_item(item.parent_id)
            var parent_items = this.get_playlist_items(parent.parent_id);
            var next_item = parent_items[parent_items.findIndex(s=>s.id == parent.id)+1];
            item = next_item || item;
        }

        this.$.playlist_id = item ? item.id : null;

        this.$.time = opts.start || 0;
        
        if (this.is_running) {
            if (item) {
                if (item.filename === "livestreamer://macro") {
                    if (item.props.function === "handover") {
                        let session_id = item.props.function_handover_session;
                        this.$.playlist_id = null;
                        this.stream.attach(session_id);
                    } else if (item.props.function === "stop") {
                        await this.stream.stop();
                        this.$.playlist_id = null;
                    }
                    return;
                } else {
                    var filename = await app.prepare(item && item.filename);
                    if (filename !== item.filename) {
                        this.logger.info(`Using '${filename}' in place of '${item.filename}'.`);
                    }
                    this.prepare_next_playlist_item();
                    item = {...item, filename};
                }
            }
            
            await this.mpv.loadfile(item, opts);
        }
    }

    playlist_get_next_item() {
        return this.get_adjacent_playlist_item(this.$.playlist_id, 1);
    }

    playlist_next() {
        var next = this.playlist_get_next_item();
        return this.playlist_play(next ? next.id : null, {allow_null:true})
    }

    is_item_playlist(id) {
        return this.get_playlist_items(id).length > 0 || (this.get_playlist_item(id) || {}).filename === "livestreamer://playlist";
    }

    async clear_playlist_props(ids) {
        if (!Array.isArray(ids)) ids = [ids];
        for (var id of ids) {
            this.$.playlist[id].props = {};
        }
    }
    
    async set_player_property(name, value, current=false) {
        if (!current && name in PLAYER_PROPS) {
            if (PLAYER_PROPS[name].default === value) delete this.$.player_default_override[name];
            else this.$.player_default_override[name] = value;
        }
        if (current) {
            var item = this.get_current_playlist_item();
            if (item) item.props[name] = value;
        }
        if (this.is_running) {
        // this.$.player[name] = val;
            await this.mpv.set_property(name, value); // , current
        }
    }

    handover(session) {
        this.stream.attach(session, false);
    }

    update_target_config(name, key, value) {
        if (!this.$.target_configs[name]) this.$.target_configs[name] = {};
        this.$.target_configs[name][key] = value;
    }
}

function save_diff(save1,save2) {
    var diff = utils.deep_diff(save1, save2);
    return diff;
}

const PER_FILE_CLASS = class extends PropertyCollection {
    aspect_ratio = {
        default: -1,
    };
    loop_file = {
        default: false,
    };
    video_track = {
        default: null,
    };
    audio_track = {
        default: null,
    };
    subtitle_track = {
        default: null,
    };
    audio_delay = {
        default: 0,
    };
    sub_delay = {
        default: 0,
    };
    sub_scale = {
        default: 1.00,
    };
    sub_pos = {
        default: 100,
    };
    speed = {
        default: 1.00,
    };
    audio_pitch_correction = {
        default: true,
    };
    deinterlace_mode = {
        default: "auto",
    };
    audio_channels = {
        default: "stereo",
    };
    volume_normalization = {
        default: "dynaudnorm1",
        options: [
            ["dynaudnorm1", `dynaudnorm=f=500:p=0.9:m=8.0:g=7`],
            ["dynaudnorm2", `dynaudnorm=f=250:p=0.9:m=8.0:g=5`],
            ["loudnorm", `loudnorm=:dual_mono=true`],
        ],
    };
    audio_visualization = {
        default: false,
    };
    /* force_fps = {
        default: null,
        options: [[null, "Variable"], 23.976, 24, 25, 30, 50, 60],
    }; */
    volume_multiplier = {
        default: 1,
    };
};
const PROPS_CLASS = InternalSession.PROPS_CLASS = class extends SessionBase.PROPS_CLASS {
    playlist_id = {
        default: -1,
    };
    schedule_start_time = {
        default: null,
    };
    background_mode = {
        default: "logo",
        options: background_mode_options(),
    };
    background_color = {
        default: "#000000",
    };
    background_file = {
        default: null,
        media:true,
    };
    background_file_start = {
        default: null,
    };
    background_file_end = {
        default: null,
    };
    interpolation_mode = {
        default: false,
        options: [["auto", "Auto"], [false, "Off"], [true, "On"]],
    };
    auto_interpolation_rate = {
        default: 30,
        options: [23.976, 24, 25, 29.97, 30, 50, 60],
    };
    files_dir = {
        default: "",
        media:true,
    };
    rtmp_key = {
        default: "",
        load: false,
    };
    volume_target = {
        default: 100,
    };
    volume_speed = {
        default: 2.0,
    };
    time = {
        default: 0,
    };

    /* player = {
        default: {},
        props: new class extends PER_FILE_CLASS {}
    }; */
    
    player_default_override = {
        default: {},
        props: new class extends PER_FILE_CLASS {}
    };

    /* file_props = {
        default: {},
    } */
    playlist = {
        default: {},
        enumerable_props: new class extends PropertyCollection {
            id = {
                default: "",
            };
            filename = {
                default: "",
            };
            index = {
                default: 0,
            };
            track_index = {
                default: 0,
            };
            parent_id = {
                default: "0",
            };
            props = {
                default: {},
                props: new class extends PER_FILE_CLASS {
                    clip_start = {
                        default: null,
                    };
                    clip_end = {
                        default: null,
                    };
                    /* clip_loops = {
                        default: 1,
                    }; */
                    clip_offset = {
                        default: 0,
                    };
                    clip_duration = {
                        default: null,
                    };
                    fade_in = {
                        default: 0,
                    };
                    fade_out = {
                        default: 0,
                    };
                    background_mode = {
                        default: null,
                        options: [[null, "None"], ["default", "Default Background"], ...background_mode_options()],
                    };
                    background_color = {
                        default: "#000000",
                    };
                    background_file = {
                        default: null,
                        media:true,
                    };
                    background_file_start = {
                        default: null,
                    };
                    background_file_end = {
                        default: null,
                    };
                    subtitle_file = {
                        default: null,
                        media:true,
                    };
                    audio_file = {
                        default: null,
                        media:true,
                    };
                    crop_left = {
                        default: 0,
                    };
                    crop_top = {
                        default: 0,
                    };
                    crop_right = {
                        default: 0,
                    };
                    crop_bottom = {
                        default: 0,
                    };
                    empty_duration = {
                        default: 0,
                    };
                    title_text = {
                        default: "",
                    };
                    title_size = {
                        default: 50,
                    };
                    title_fade = {
                        default: 0.5,
                    };
                    title_duration = {
                        default: 5,
                    };
                    title_font = {
                        default: "Arial",
                        options: [["Arial", "Arial"]],
                    };
                    title_color = {
                        default: "#ffffff",
                    };
                    title_style = {
                        default: "",
                        options: [["", "Regular"], ["bold", "Bold"], ["italic", "Italic"], ["bold+italic", "Bold & Italic"]],
                    };
                    title_alignment = {
                        default: 5,
                        options: [[1, "Bottom Left"], [2, "Bottom Center"], [3, "Bottom Right"], [4, "Center Left"], [5, "Center"], [6, "Center Right"], [7, "Top Left"], [8, "Top Center"], [9, "Top Right"]],
                    };
                    title_spacing = {
                        default: 0,
                    };
                    title_outline_thickness = {
                        default: 0,
                    };
                    title_outline_color = {
                        default: "#000000",
                    };
                    title_shadow_depth = {
                        default: 0,
                    };
                    title_shadow_color = {
                        default: "#000000",
                    };
                    title_underline = {
                        default: false,
                    };
                    title_rotation = {
                        default: [0,0,0],
                    };
                    title_margin = {
                        default: 10,
                    };
                    function = {
                        default: null,
                        options:[[null, "Do Nothing"], ["stop", "Stop Streaming"], ["handover", "Handover"]],
                    };
                    function_handover_session = {
                        default: null,
                    };
                    playlist_mode = {
                        default: 0,
                        options: [[0,"Normal"],[1,"Merged"],[2,"2-Track"]],
                    };
                    playlist_end_on_shortest_track = {
                        default: false,
                    };
                    playlist_revert_to_video_track_audio = {
                        default: false,
                    };
                    /* playlist_timeline_eof = {
                        default: 0,
                        options: [[0,"Crop to Length of Shortest Track"],[1,"Pad to Length of Longest Track"]],
                    }; */
                    // --------
                    label = {
                        default: null,
                        ignore: true,
                    };
                    color = {
                        default: null,
                        ignore: true,
                    };
                }
            };
        }
    };
    detected_crops = {
        default: {},
        save:false,
    };
    playlist_info = {
        default: {},
        save: false,
    };
    last_stream = {
        default: {},
        save: false,
    };
}

const PROPS = InternalSession.PROPS = new PROPS_CLASS();
const PLAYER_PROPS = InternalSession.PLAYER_PROPS = new PER_FILE_CLASS();

function diff_tree_to_list(t) {
    return utils.deep_entries(t, true, (k,v)=>Array.isArray(v)?false:true);
}

function background_mode_options() {
    return [["logo",`Logo`], ["color", "Color"], ["embedded", "Embedded Artwork"], ["external", "External Artwork"]];
}

function replace_prop($, old_names, new_name){
    if (!Array.isArray(old_names)) old_names = [old_names];
    for (var old_name of old_names) {
        if (old_name in $) {
            $[new_name] = $[old_name];
            delete $[old_name];
        }
    }
}
function modify_prop($, names, modifier){
    if (!Array.isArray(names)) names = [names];
    for (var name of names) {
        if (name in $) {
            $[name] = modifier($[name]);
        }
    }
}

export default InternalSession;