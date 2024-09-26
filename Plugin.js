import path from "node:path";
import fs from "fs-extra";
import { utils } from "@livestreamer/core";
import { app } from "./internal.js";

class Plugin {
    constructor(id, dir, options) {
        this.id = id;
        this.dir = path.resolve(dir);
        if (app.$.plugins[this.id]) delete app.$.plugins[this.id];
        var json = JSON.parse(fs.readFileSync(path.join(this.dir, "plugin.json"), "utf-8"));
        app.plugins[this.id] = this;
        app.$.plugins[this.id] = {
            id: this.id,
            front_js: fs.readFileSync(path.join(this.dir, json.front), "utf-8"),
            front_url: `plugins/${this.id}/`+json.front,
            core: json.core,
            options
        };
        if (json.core) utils.import(file_url(json.core));
    }

    destroy() {
        delete app.plugins[this.id];
        delete app.$.plugins[this.id];
        // this.watcher.close();
    }
}

export default Plugin;