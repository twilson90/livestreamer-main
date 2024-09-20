const fs = require("fs-extra");
const ClientBase = require("@livestreamer/core/ClientBase");
const utils = require("@livestreamer/core/utils");
const core = require("@livestreamer/core");

class Client extends ClientBase {
    get session() { return app.sessions[this.$.session_id]; }
    get sessions() { return app.sessions; }
    get app() { return app; }
    get core() { return core; }

    init() {
        app.$.clients[this.id] = this.$;
        this.send({ $: utils.deep_copy(app.$) });
    }

    // get is_blocked() { return App.instance.app_blocklist.is_blocked(this.$.username); }

    new_session() {
        var s = new InternalSession();
        s.$.access_control[this.username] = {"access":"owner"}
        this.attach_to(s.id);
    }

    rearrange_sessions(old_index, new_index) {
        var sessions = utils.sort(Object.values(app.sessions), s=>s.$.index);
        utils.array_move(sessions, old_index, new_index);
        sessions.forEach((s,i)=>s.$.index = i);
    }

    attach_to(session_id) {
        if (this.$.session_id == session_id) return;
        // if (this.session) this.session.emit("detach", this);
        if (!app.sessions[session_id]) session_id = null;
        this.$.session_id = session_id;
        // if (this.session) this.session.emit("attach", this);
    }

    async save_file(dir, file, data) {
        var fullpath = await app.evaluate_filename(dir, file).catch(e=>core.logger.error(e.message));
        if (fullpath) await fs.writeFile(fullpath, data);
    }
}

module.exports = Client;

const app = require(".");
const InternalSession = require("./InternalSession.js");
const Target = require("./Target.js");
