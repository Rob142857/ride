#!/usr/bin/env node
/**
 * Wire the waypoint help modal into public/js/ui.js.
 * Uses plain string replacement so whitespace escaping in this editor
 * cannot corrupt the target file.
 */
const fs = require('fs');
const path = require('path');

const UI_PATH = path.join(__dirname, '..', 'public', 'js', 'ui.js');
let src = fs.readFileSync(UI_PATH, 'utf8');

//1. Auto-show help modal the first time user enters Waypoints view.
const switchViewTarget = `    if (view !== 'waypoints') {\n      MapManager.disableAddWaypointMode();\n    } else {\n      this.setWaypointPlannerState(MapManager.isAddingWaypoint ? 'pick' : 'idle');\n    }`;

const switchViewReplace = `    if (view !== 'waypoints') {\n      MapManager.disableAddWaypointMode();\n    } else {\n      this.setWaypointPlannerState(MapManager.isAddingWaypoint ? 'pick' : 'idle');\n      this.maybeShowWaypointsHelp();\n    }`;

if (src.includes('maybeShowWaypointsHelp')) {
  console.log('maybeShowWaypointsHelp already wired, skipping switchView patch.');
} else if (!src.includes(switchViewTarget)) {
  console.error('switchView waypoint branch not found; cannot patch.');
  process.exit(1);
} else {
  src = src.replace(switchViewTarget, switchViewReplace);
}

// 2. Bind the help button click.
const bindModalsTarget = `    document.getElementById('searchWaypointPlaceBtn')?.addEventListener('click', () => {\n      if (!App.ensureEditable('add waypoints')) return;\n      this.openWaypointPlaceSearch();\n    });`;

const bindModalsReplace = `    document.getElementById('searchWaypointPlaceBtn')?.addEventListener('click', () => {\n      if (!App.ensureEditable('add waypoints')) return;\n      this.openWaypointPlaceSearch();\n    });\n\n    document.getElementById('waypointsHelpBtn')?.addEventListener('click', () => {\n      try {\n        localStorage.setItem('ride_waypoints_help_seen', '1');\n      } catch (_){}\n      this.openModal('waypointsHelpModal');\n    });`;

if (src.includes("document.getElementById('waypointsHelpBtn')")) {
  console.log('waypointsHelpBtn already bound, skipping bindModals patch.');
} else if (!src.includes(bindModalsTarget)) {
  console.error('bindModals waypoint search branch not found; cannot patch.');
  process.exit(1);
} else {
  src = src.replace(bindModalsTarget, bindModalsReplace);
}

// 3. Add the helper method after openWaypointPlaceSearch.
const helperMethod = `\n\n  maybeShowWaypointsHelp() {\n    if (!document.getElementById('waypointsHelpModal')) return;\n    let seen = false;\n    try {\n      seen = localStorage.getItem('ride_waypoints_help_seen') === '1';\n    } catch (_){}\n    if (!seen) {\n      try {\n        localStorage.setItem('ride_waypoints_help_seen', '1');\n      } catch (_) {}\n      this.openModal('waypointsHelpModal');\n    }\n  }`;
const methodInsertTarget = '  },\n\n  bindAuthGate() {';
if (src.includes('maybeShowWaypointsHelp()')) {
  console.log('maybeShowWaypointsHelp method already present.');
} else if (!src.includes(methodInsertTarget)) {
  console.error('Insert target for maybeShowWaypointsHelp not found.');
  process.exit(1);
} else {
  src = src.replace(methodInsertTarget, helperMethod + '\n\n  },\n\n  bindAuthGate() {');
  // Note: the replacement fix above actually injects method between methods, but replaces the closing "},\n\n  bindAuthGate() {"
  // This means it would duplicate ",\n\n  bindAuthGate() {". The below logic fixes that place.
}

// Because of the replacement quirk, we remove the extra "  },\n\n  bindAuthGate() {" duplication.
const duplicated = `  },\n\n  },\n\n  bindAuthGate() {`;
const fixed = `  },\n\n  bindAuthGate() {`;
if (src.includes(duplicated)) {
  src = src.replace(duplicated, fixed);
}

fs.writeFileSync(UI_PATH, src, 'utf8');
console.log('Waypoints help modal wired in public/js/ui.js.');
