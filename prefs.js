import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensionPrefs/prefs.js';

const CORNERS = ['right', 'left'];

export default class ShowDesktopCornerPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'preferences-desktop-display-symbolic',
        });
        window.add(page);

        const placement = new Adw.PreferencesGroup({
            title: _('Placement'),
            description: _('The bar sits inside the strip the dock already reserves, so it lines up with the dock icons.'),
        });
        page.add(placement);

        const corner = new Adw.ComboRow({
            title: _('Corner'),
            subtitle: _('Which bottom corner the bar is pinned to'),
            model: new Gtk.StringList({strings: [_('Bottom right'), _('Bottom left')]}),
            selected: Math.max(0, CORNERS.indexOf(settings.get_string('corner'))),
        });
        corner.connect('notify::selected', () => {
            settings.set_string('corner', CORNERS[corner.selected] ?? 'right');
        });
        placement.add(corner);

        const width = new Adw.SpinRow({
            title: _('Width'),
            subtitle: _('Thickness of the bar, in pixels'),
            adjustment: new Gtk.Adjustment({lower: 2, upper: 120, step_increment: 1, page_increment: 5}),
        });
        settings.bind('button-width', width, 'value', Gio.SettingsBindFlags.DEFAULT);
        placement.add(width);

        const margin = new Adw.SpinRow({
            title: _('Distance from the screen edge'),
            subtitle: _('0 puts it flush in the corner, like Windows'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 400, step_increment: 1, page_increment: 10}),
        });
        settings.bind('edge-margin', margin, 'value', Gio.SettingsBindFlags.DEFAULT);
        placement.add(margin);

        const look = new Adw.PreferencesGroup({
            title: _('Look'),
            description: _('Background colour, transparency and corner rounding are always read from the dock itself and cannot be set here.'),
        });
        page.add(look);

        const matchHeight = new Adw.SwitchRow({
            title: _('Match the dock’s height'),
            subtitle: _('Off: fill the whole reserved strip at the bottom of the screen'),
        });
        settings.bind('match-dock-height', matchHeight, 'active', Gio.SettingsBindFlags.DEFAULT);
        look.add(matchHeight);

        const separator = new Adw.SwitchRow({
            title: _('Separator line'),
            subtitle: _('Faint hairline on the inner edge'),
        });
        settings.bind('show-separator', separator, 'active', Gio.SettingsBindFlags.DEFAULT);
        look.add(separator);

        const hover = new Adw.SwitchRow({
            title: _('Highlight on hover'),
        });
        settings.bind('hover-highlight', hover, 'active', Gio.SettingsBindFlags.DEFAULT);
        look.add(hover);
    }
}
