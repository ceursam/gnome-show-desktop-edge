/* 
Show Desktop Corner
A thin "show desktop" bar pinned to the bottom-right corner of the screen,
sitting inside the strip that a non-autohiding Ubuntu Dock already reserves.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const DTD_SCHEMA = 'org.gnome.shell.extensions.dash-to-dock';

const DOCK_NAME_PREFIX = 'dashtodock';

const UPDATE_DELAY = 80;
const SETTLE_DELAYS = [400, 1500, 4000];
const FALLBACK_HEIGHT = 64;

const DEFAULTS = {
    'button-width': 14,
    'edge-margin': 0,
    'corner': 'right',
    'show-separator': true,
    'hover-highlight': true,
    'match-dock-height': true,
};

function parseCssColor(str) {
    if (!str)
        return null;

    const s = String(str).trim().toLowerCase();

    let m = /^#([0-9a-f]+)$/.exec(s);
    if (m) {
        let hex = m[1];
        if (hex.length === 3 || hex.length === 4)
            hex = [...hex].map(c => c + c).join('');
        if (hex.length !== 6 && hex.length !== 8)
            return null;
        return {
            red: parseInt(hex.slice(0, 2), 16),
            green: parseInt(hex.slice(2, 4), 16),
            blue: parseInt(hex.slice(4, 6), 16),
            alpha: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255,
        };
    }

    m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (m) {
        const parts = m[1].split(/[,/]/).map(v => v.trim()).filter(v => v !== '');
        if (parts.length < 3)
            return null;
        const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
        const chan = v => clamp(v.endsWith('%') ? parseFloat(v) * 2.55 : parseFloat(v));
        return {
            red: chan(parts[0]),
            green: chan(parts[1]),
            blue: chan(parts[2]),
            alpha: parts.length > 3 ? clamp(parseFloat(parts[3]) * 255) : 255,
        };
    }

    return null;
}

function normalizeColor(c) {
    if (!c)
        return null;
    const {red, green, blue, alpha} = c;
    if ([red, green, blue, alpha].some(v => typeof v !== 'number'))
        return null;
    const isFloat = red <= 1 && green <= 1 && blue <= 1 && alpha <= 1;
    const f = v => Math.max(0, Math.min(255, Math.round(isFloat ? v * 255 : v)));
    return {red: f(red), green: f(green), blue: f(blue), alpha: f(alpha)};
}

function monitorAt(x, y) {
    for (const m of Main.layoutManager.monitors) {
        if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height)
            return m;
    }
    return Main.layoutManager.primaryMonitor;
}

export default class ShowDesktopCornerExtension extends Extension {
    enable() {
        this._signals = [];
        this._dockSignals = [];
        this._timeouts = [];
        this._updateId = 0;
        this._dockActor = null;
        this._dockBackground = null;
        this._minimized = [];
        this._lastFocus = null;

        this._lastStyle = null;
        this._lastRadiusCss = null;
        this._lastGeometry = null;

        try {
            this._settings = this.getSettings();
        } catch (e) {
            this._settings = null;
            console.warn(`${this.metadata.name}: no compiled schema, using defaults (${e.message})`);
        }
        this._dockSettings = this._lookupDockSettings();

        this._buildButton();
        this._connectSignals();

        this._update();
        for (const delay of SETTLE_DELAYS)
            this._addTimeout(delay, () => this._update());
    }

    disable() {
        for (const id of this._timeouts)
            GLib.Source.remove(id);
        this._timeouts = [];

        if (this._updateId) {
            GLib.Source.remove(this._updateId);
            this._updateId = 0;
        }

        this._disconnectDock();
        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];

        if (this._button) {
            Main.layoutManager.removeChrome(this._button);
            this._button.destroy();
            this._button = null;
            this._highlight = null;
        }

        this._settings = null;
        this._dockSettings = null;
        this._dockActor = null;
        this._dockBackground = null;
        this._minimized = [];
        this._lastFocus = null;
    }

    _lookupDockSettings() {
        try {
            const source = Gio.SettingsSchemaSource.get_default();
            const schema = source?.lookup(DTD_SCHEMA, true);
            return schema ? new Gio.Settings({settings_schema: schema}) : null;
        } catch (e) {
            return null;
        }
    }

    _int(key) {
        try {
            return this._settings ? this._settings.get_int(key) : DEFAULTS[key];
        } catch (e) {
            return DEFAULTS[key];
        }
    }

    _bool(key) {
        try {
            return this._settings ? this._settings.get_boolean(key) : DEFAULTS[key];
        } catch (e) {
            return DEFAULTS[key];
        }
    }

    _str(key) {
        try {
            return this._settings ? this._settings.get_string(key) : DEFAULTS[key];
        } catch (e) {
            return DEFAULTS[key];
        }
    }

    /** Read a dash-to-dock key, tolerating keys that differ between versions. */
    _dock(getter, key, fallback) {
        try {
            if (!this._dockSettings)
                return fallback;
            if (!this._dockSettings.settings_schema.has_key(key))
                return fallback;
            return this._dockSettings[getter](key);
        } catch (e) {
            return fallback;
        }
    }

    _buildButton() {
        this._button = new St.Button({
            style_class: 'show-desktop-corner',
            reactive: true,
            can_focus: false,
            track_hover: true,
            x_expand: false,
            y_expand: false,
        });
        this._button.accessible_name = _('Show Desktop');

        this._highlight = new St.Widget({
            style_class: 'show-desktop-corner-highlight',
            opacity: 0,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._button.set_child(this._highlight);

        this._button.connect('clicked', () => this._toggleShowDesktop());
        this._button.connect('notify::hover', () => this._syncHighlight());
        this._button.connect('destroy', () => {
            this._button = null;
            this._highlight = null;
        });

        Main.layoutManager.addChrome(this._button, {
            affectsStruts: false,
            affectsInputRegion: true,
            trackFullscreen: true,
        });
    }

    _connectSignals() {
        const add = (obj, signal, cb) => {
            if (obj)
                this._signals.push([obj, obj.connect(signal, cb)]);
        };
        const queue = () => this._queueUpdate();

        add(Main.layoutManager, 'monitors-changed', queue);
        add(Main.layoutManager, 'startup-complete', queue);
        add(global.display, 'workareas-changed', queue);
        add(Main.overview, 'showing', queue);
        add(Main.overview, 'hidden', queue);
        add(St.ThemeContext.get_for_stage(global.stage), 'changed', queue);

        add(Main.extensionManager, 'extension-state-changed', (_mgr, ext) => {
            if (!ext || ext.uuid.includes('dash-to-dock') || ext.uuid.includes('ubuntu-dock'))
                this._dropDock();
            this._queueUpdate();
        });

        add(this._settings, 'changed', queue);
        add(this._dockSettings, 'changed', queue);
    }

    _addTimeout(delay, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, delay, () => {
            this._timeouts = this._timeouts.filter(i => i !== id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.push(id);
    }

    _queueUpdate() {
        if (this._updateId)
            return;
        this._updateId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, UPDATE_DELAY, () => {
            this._updateId = 0;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    _update() {
        if (!this._button)
            return;
        this._findDock();
        this._syncStyle();
        this._syncGeometry();
    }

    _dropDock() {
        this._disconnectDock();
        this._dockActor = null;
        this._dockBackground = null;
    }

    _disconnectDock() {
        for (const [obj, id] of this._dockSignals) {
            try {
                obj.disconnect(id);
            } catch (e) {
            }
        }
        this._dockSignals = [];
    }

    _findDock() {
        if (this._dockActor && this._dockActor.get_parent() && this._dockBackground)
            return;

        this._dropDock();

        const actor = this._scanForDock();
        if (!actor)
            return;

        this._dockActor = actor;
        this._dockBackground = this._findBackground(actor) ?? actor;

        const add = (obj, signal, cb) => this._dockSignals.push([obj, obj.connect(signal, cb)]);
        add(this._dockBackground, 'style-changed', () => this._queueUpdate());
        add(this._dockBackground, 'notify::allocation', () => this._queueUpdate());
        add(this._dockActor, 'notify::visible', () => this._queueUpdate());
        add(this._dockActor, 'destroy', () => {
            this._dropDock();
            this._queueUpdate();
        });
    }

    _scanForDock() {
        const found = [];
        const visit = (actor, depth) => {
            for (const child of actor.get_children()) {
                if (child === this._button)
                    continue;
                if ((child.name ?? '').startsWith(DOCK_NAME_PREFIX)) {
                    found.push(child);
                    continue;
                }
                if (depth < 2)
                    visit(child, depth + 1);
            }
        };

        try {
            visit(Main.layoutManager.uiGroup, 0);
        } catch (e) {
            return null;
        }

        if (found.length === 0)
            return null;

        const primary = Main.layoutManager.primaryMonitor;
        const onPrimary = found.filter(a => {
            try {
                const [x, y] = a.get_transformed_position();
                const [w, h] = a.get_transformed_size();
                return monitorAt(x + w / 2, y + h / 2) === primary;
            } catch (e) {
                return false;
            }
        });

        const pool = onPrimary.length > 0 ? onPrimary : found;
        return pool.reduce((best, a) => (a.width > (best?.width ?? -1) ? a : best), null);
    }

    _findBackground(root) {
        const queue = [[root, 0]];
        let best = null;
        let bestArea = -1;

        while (queue.length > 0) {
            const [actor, depth] = queue.shift();

            if (actor instanceof St.Widget) {
                const cls = actor.style_class ?? '';
                if (cls.includes('dash-background'))
                    return actor;

                const color = this._colorOf(actor);
                if (color && color.alpha > 0) {
                    const area = actor.width * actor.height;
                    if (area > bestArea) {
                        best = actor;
                        bestArea = area;
                    }
                }
            }

            if (depth < 5) {
                for (const child of actor.get_children())
                    queue.push([child, depth + 1]);
            }
        }

        return best;
    }

    _colorOf(actor) {
        try {
            if (!actor || !actor.get_stage())
                return null;
            return normalizeColor(actor.get_theme_node().get_background_color());
        } catch (e) {
            return null;
        }
    }

    _scaleFactor() {
        try {
            return St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        } catch (e) {
            return 1;
        }
    }

    _syncStyle() {
        const scale = this._scaleFactor();
        const color = this._colorOf(this._dockBackground) ?? this._fallbackColor();
        const radii = this._dockRadii(scale);

        const onRight = this._str('corner') !== 'left';
        const tl = onRight ? radii[0] : 0;
        const tr = onRight ? 0 : radii[1];
        const br = onRight ? 0 : radii[2];
        const bl = onRight ? radii[3] : 0;

        const alpha = (color.alpha / 255).toFixed(3);
        const radiusCss = `border-radius: ${tl}px ${tr}px ${br}px ${bl}px;`;

        let style = `background-color: rgba(${color.red}, ${color.green}, ${color.blue}, ${alpha}); ${radiusCss}`;

        if (this._bool('show-separator')) {
            const side = this._str('corner') === 'left' ? 'right' : 'left';
            style += ` border-${side}: 1px solid rgba(255, 255, 255, 0.12);`;
        }

        if (style !== this._lastStyle) {
            this._button.set_style(style);
            this._lastStyle = style;
        }

        if (radiusCss !== this._lastRadiusCss) {
            this._highlight.set_style(radiusCss);
            this._lastRadiusCss = radiusCss;
        }
    }

    _dockRadii(scale) {
        const corners = [St.Corner.TOPLEFT, St.Corner.TOPRIGHT, St.Corner.BOTTOMRIGHT, St.Corner.BOTTOMLEFT];
        try {
            if (this._dockBackground?.get_stage()) {
                const node = this._dockBackground.get_theme_node();
                return corners.map(c => Math.round(node.get_border_radius(c) / scale));
            }
        } catch (e) {
        }
        return [8, 8, 8, 8];
    }

    _fallbackColor() {
        let base = {red: 0, green: 0, blue: 0, alpha: 255};

        if (this._dock('get_boolean', 'custom-background-color', false))
            base = parseCssColor(this._dock('get_string', 'background-color', '')) ?? base;

        let alpha = 0.8;
        const mode = this._dock('get_string', 'transparency-mode', 'DEFAULT');
        if (mode === 'FIXED') {
            alpha = this._dock('get_double', 'background-opacity', 0.8);
        } else if (mode === 'DYNAMIC') {
            alpha = this._dock('get_boolean', 'customize-alphas', false)
                ? this._dock('get_double', 'max-alpha', 0.8)
                : 0.8;
        } else {
            alpha = this._dock('get_double', 'background-opacity', 0.8);
        }

        return {...base, alpha: Math.max(0, Math.min(255, Math.round(alpha * 255)))};
    }

    _syncHighlight() {
        if (!this._highlight)
            return;
        const on = this._bool('hover-highlight') && this._button.hover;
        this._highlight.ease({
            opacity: on ? 255 : 0,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _syncGeometry() {
        const scale = this._scaleFactor();
        const strip = this._dockStrip();
        const monitor = strip.monitor;

        const width = Math.max(2, Math.round(this._int('button-width') * scale));
        const margin = Math.max(0, Math.round(this._int('edge-margin') * scale));

        const x = this._str('corner') === 'left'
            ? monitor.x + margin
            : monitor.x + monitor.width - width - margin;

        const height = Math.round(strip.height);
        const left = Math.round(x);
        const top = Math.round(strip.y);

        const key = `${left},${top},${width},${height}`;
        if (key !== this._lastGeometry) {
            this._button.set_size(width, height);
            this._button.set_position(left, top);
            this._lastGeometry = key;
        }

        this._button.visible = height > 1;
    }

    _dockStrip() {
        const scale = this._scaleFactor();
        const primary = Main.layoutManager.primaryMonitor;

        if (this._bool('match-dock-height') && this._dockBackground && this._dockActor?.visible) {
            try {
                const [, by] = this._dockBackground.get_transformed_position();
                const [, bh] = this._dockBackground.get_transformed_size();
                const monitor = monitorAt(primary.x + primary.width / 2, by + bh / 2);
                if (bh > 1 && bh < monitor.height / 2)
                    return {monitor, y: by, height: bh};
            } catch (e) {
            }
        }

        const index = Main.layoutManager.primaryIndex;
        let height = 0;
        try {
            const workArea = Main.layoutManager.getWorkAreaForMonitor(index);
            height = (primary.y + primary.height) - (workArea.y + workArea.height);
        } catch (e) {
            height = 0;
        }

        if (height <= 8)
            height = FALLBACK_HEIGHT * scale;

        return {
            monitor: primary,
            y: primary.y + primary.height - height,
            height,
        };
    }

    _toggleShowDesktop() {
        if (Main.overview.visible)
            Main.overview.hide();

        const alive = w => {
            try {
                return w.get_compositor_private() !== null;
            } catch (e) {
                return false;
            }
        };

        const restorable = this._minimized.filter(w => alive(w) && w.minimized);
        if (restorable.length > 0) {
            const focus = this._lastFocus;
            this._minimized = [];
            this._lastFocus = null;

            for (const w of restorable.slice().reverse())
                w.unminimize();

            if (focus && alive(focus) && restorable.includes(focus))
                focus.activate(global.get_current_time());
            return;
        }

        const workspace = global.workspace_manager.get_active_workspace();
        const windows = global.display
            .get_tab_list(Meta.TabList.NORMAL, workspace)
            .filter(w => !w.minimized &&
                          w.can_minimize() &&
                          !w.is_skip_taskbar() &&
                          w.get_window_type() !== Meta.WindowType.DESKTOP);

        this._lastFocus = global.display.focus_window;
        this._minimized = windows;

        for (const w of windows)
            w.minimize();
    }
}

function _(str) {
    return str;
}
