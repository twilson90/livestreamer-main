const path = require("node:path");
const fs = require("fs-extra");
const utils = require("@livestreamer/core/utils");
// const chokidar = require("chokidar");

class Plugin {
    constructor(dir) {
        this.dir = path.resolve(dir);
        this.id = path.basename(dir);
        if (app.$.plugins[this.id]) delete app.$.plugins[this.id];
        // this.watcher = chokidar.watch(dir, {awaitWriteFinish:true});
        // this.watcher.on("change", (...args)=>{
        //     update();
        // });
        // var files = ["front.js", "front.css", "front.html"];
        // var update = ()=>{
        //     app.$.plugins[this.id] = {};
        //     for (var f of files) {
        //         var filepath = path.join(dir, f);
        //         if (fs.existsSync(filepath)) {
        //             var ext = path.extname(filepath).slice(1);
        //             app.$.plugins[this.id][ext] = fs.readFileSync(filepath, "utf8");
        //         }
        //     }
        // }
        // update();
        var json = JSON.parse(fs.readFileSync(path.join(this.dir, "plugin.json"), "utf-8"));
        app.plugins[this.id] = this;
        app.$.plugins[this.id] = {
            id: this.id,
            js: `plugins/${this.id}/`+json.front,
            has_core: !!json.core,
        };
        if (json.core) utils.require(json.core);
    }

    destroy() {
        delete app.plugins[this.id];
        delete app.$.plugins[this.id];
        // this.watcher.close();
    }
}

module.exports = Plugin;

const app = require(".");