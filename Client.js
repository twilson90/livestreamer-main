import fs from "fs-extra";
import ClientBase from "@livestreamer/core/ClientBase.js";
import { core, utils } from "@livestreamer/core";
import { app, InternalSession } from "./internal.js";


class Client extends ClientBase {
    get session() { return app.sessions[this.$.session_id]; }
    get sessions() { return app.sessions; }
    get app() { return app; }
    get core() { return core; }

    init() {
        app.$.clients[this.id] = this.$;
        
        var session_id = this.url.searchParams.get("session_id");
        if (session_id) this.attach_to(session_id);
        var $ = utils.deep_copy(app.$);
        $.conf = {
            ["auth"]: core.auth,
            ["debug"]: core.debug,
            ["media-server.name"]: core.conf["media-server.name"],
            ["media-server.rtmp_port"]: core.conf["media-server.rtmp_port"],
            ["session-order-client"]: core.conf["session-order-client"],
        }
        this.send({ $ });
    }

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
    destroy() {
        super.destroy();
        delete app.$.clients[this.id];
    }
}

export default Client;