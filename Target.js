const fs = require("fs-extra");
const path = require("node:path");
const DataNode = require("@livestreamer/core/DataNode");
const core = require("@livestreamer/core");

class Target extends DataNode {
    get streams() { return Object.values(app.streams).filter(s=>s.stream_targets[this.id]); }
    get name() { return this.$.name; }
    get description() { return this.$.description; }
    get rtmp_host() { return this.$.rtmp_host; }
    get rtmp_key() { return this.$.rtmp_key; }
    get title() { return this.$.title; }
    get url() { return this.$.url; } // viewing url
    get access_control() { return this.$.access_control; }
    get ts() { return this.$.ts; }
    get limit() { return this.$.limit; } // number of streams that can be done concurrently
    get locked() { return this.$.locked; }

    /** @param {{stream:import("./Stream"), session:import("./SessionBase")} ctx} @param {any} config @return {any} */
    evaluate(ctx, config) {
        var data = {...this.$};
        Object.assign(data, this.config(ctx, config));
        data.rtmp_url = data.rtmp_key ? data.rtmp_host.replace(/\/+$/, "") + "/" + data.rtmp_key.replace(/^\/+/, "") : data.rtmp_host;
        return data;
    }

    constructor(data) {
        data = {
            limit: 1,
            ...data
        };
        var config = data.config || (()=>{});
        delete data.config;
        delete data.stream_priority;
        delete data.stream_id;
        super(data.id);
        this.config = config;
        app.targets[this.id] = this;
        app.$.targets[this.id] = this.$;
        this.#update(data);
    }

    #update(data) {
        Object.assign(this.$, data);
        if (!this.$.locked) this.$.ts = Date.now();
        if (!this.$.ts) this.$.ts = Date.now();
        if (!this.$.access_control) this.$.access_control = {};
        app.fix_access_control(this.$.access_control);
    }
    
    /** @param {Target} data */
    async update(data) {
        this.#update(data);
        await this.save();
    }

    async save() {
        if (!this.locked) {
            var data = {...this.$};
            await fs.writeFile(path.resolve(app.targets_dir, this.id), JSON.stringify(data, null, 4));
        }
    }
    
    async destroy() {
        delete app.targets[this.id];
        if (!this.locked) {
            await fs.unlink(path.resolve(app.targets_dir, this.id)).catch(()=>{});
        }
        super.destroy();
    }
}

module.exports = Target;

const app = require(".");