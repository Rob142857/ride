const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'public', 'index.html');
let html = fs.readFileSync(file, 'utf8');

const S = String.fromCharCode(32);
const J = (a) => a.join(S);

const helpPath = J([
  'M12','2C6.48','2','2','6.48','2','12s4.48','10','10','10','10-4.48','10-10S17.52','2','12','2zm1','17h-2v-2h2v2zm2.07-7.75c-.91','1.21-2.48','1.68-2.98','2.03-.64.46-.93.76-1.08','1.26-.12.38-.03','1.05.08','1.36h-2.16c-.18-.56-.23-1.18-.02-1.79.35-.96','1.22-1.64','2.13-2.22.84-.54','1.36-.93','1.36-1.74','0-.77-.7-1.36-1.62-1.36-.86','0-1.54.56-1.72','1.36H8.64c.21-1.92','1.92-3.36','4.06-3.36','2.35','0','4.04','1.56','4.04','3.46','0','1.19-.62','1.67-2.67','2.9z'
]);

const refreshPath = J([
  'M17.65','6.35C16.2','4.9','14.21','4','12','4c-4.42','0-7.99','3.58-7.99','8s3.57','8','7.99','8c3.73','0','6.84-2.55','7.73-6h-2.08c-.82','2.33-3.04','4-5.65','4-3.31','0-6-2.69-6-6s2.69-6','6-6c1.66','0','3.14.69','4.22','1.78L13','11h7V4l-2.35','2.35z'
]);

const undoPath = J([
  'M12.5','8c-2.65','0-5.05.99-6.9','2.6L2','7v9h9l-3.62-3.62c1.39-1.16','3.16-1.88','5.12-1.88','3.54','0','6.55','2.31','7.65','5.5l2.37-.78C21.08','11.03','17.15','8','12.5','8z'
]);

const redoPath = J([
  'M11.5','8c2.65','0','5.05.99','6.9','2.6L21','7v9h-9l3.62-3.62c-1.39-1.16-3.16-1.88-5.12-1.88-3.54','0-6.55','2.31-7.65','5.5l-2.37-.78C2.92','11.03','6.85','8','11.5','8z'
]);

const fitPath = J([
  'M9','5v2H6.11L12','12.89','17.89','7H15V5h6v6h-2V8.11l-5.89','5.89L18','19.89V17h2v6h-6v-2h2.89L12','15.11','6.11','21H9v2H3v-6h2v2.89l5.89-5.89L5','8.11V11H3V5h6z'
]);

const pinPath = J([
  'M12','2C8.13','2','5','5.13','5','9c0','5.25','7','13','7','13s7-7.75','7-13c0-3.87-3.13-7-7-7zm0','9.5c-1.38','0-2.5-1.12-2.5-2.5s1.12-2.5','2.5-2.5','2.5','1.12','2.5','2.5-1.12','2.5-2.5','2.5z'
]);

const searchPath = J([
  'M15.5','14h-.79l-.28-.27C15.41','12.59','16','11.11','16','9.5','16','5.91','13.09','3','9.5','3S3','5.91','3','9.5','5.91','16','9.5','16c1.61','0','3.09-.59','4.23-1.57l.27.28v.79l5','4.99L20.49','19l-4.99-5zM9.5','14C7.01','14','5','11.99','5','9.5S7.01','5','9.5','5','14','7.01','14','9.5','11.99','14','9.5','14z'
]);

const v24 = J(['0','0','24','24']);

const helpIcon = `<svg viewBox="${v24}" aria-hidden="true"><path d="${helpPath}"/></svg>`;
const refreshIcon = `<svg viewBox="${v24}" aria-hidden="true"><path d="${refreshPath}"/></svg>`;
const undoIcon = `<svg viewBox="${v24}" aria-hidden="true"><path d="${undoPath}"/></svg>`;
const redoIcon = `<svg viewBox="${v24}" aria-hidden="true"><path d="${redoPath}"/></svg>`;
const fitIcon = `<svg viewBox="${v24}" aria-hidden="true"><path d="${fitPath}"/></svg>`;
const pinIcon = `<svg viewBox="${v24}" aria-hidden="true"><path d="${pinPath}"/></svg>`;
const searchIcon = `<svg viewBox="${v24}" aria-hidden="true"><path d="${searchPath}"/></svg>`;

const waypointsSection = `<section id="waypointsPanel" class="panel hidden">
      <div class="waypoints-drawer">
        <div class="panel-header waypoints-header">
          <div class="panel-title">
            <h2>Waypoints</h2>
            <button id="waypointsHelpBtn" class="icon-btn heading-help" title="How to use waypoints" aria-label="How to use waypoints">
              ${helpIcon}
            </button>
            <button id="refreshWaypointsBtn" class="icon-btn heading-refresh" aria-label="Refresh waypoints">
              ${refreshIcon}
            </button>
          </div>
          <div class="panel-actions waypoints-toolbar">
            <button id="undoWaypointBtn" class="toolbar-btn" title="Undo last waypoint change" disabled aria-label="Undo last waypoint change">
              ${undoIcon}
              <span>Undo</span>
            </button>
            <button id="redoWaypointBtn" class="toolbar-btn" title="Redo last waypoint change" disabled aria-label="Redo last waypoint change">
              ${redoIcon}
              <span>Redo</span>
            </button>
            <button id="fitWaypointsBtn" class="toolbar-btn" title="Fit map to all waypoints" aria-label="Fit map to all waypoints">
              ${fitIcon}
              <span>Fit trip</span>
            </button>
            <button id="addWaypointBtn" class="toolbar-btn primary" title="Drop a waypoint on the map" aria-label="Drop a waypoint on the map">
              ${pinIcon}
              <span>Drop</span>
            </button>
            <button id="searchWaypointPlaceBtn" class="toolbar-btn" title="Search for a place" aria-label="Search for a place">
              ${searchIcon}
              <span>Search</span>
            </button>
          </div>
        </div>
        <div class="waypoints-panel-body">
          <div class="waypoint-planner-card slim">
            <div id="waypointPlannerStatus" class="waypoint-planner-status">Ready. Choose a waypoint source to begin.</div>
          </div>
          <div id="waypointsList" class="waypoints-list"></div>
        </div>
      </div>
    </section>`;

const start = html.indexOf('<section id="waypointsPanel"');
if (start === -1) throw new Error('waypointsPanel section not found');
const end = html.indexOf('</section>', start);
if (end ===-1) throw new Error('waypointsPanel closing tag not found');
const before = html.slice(0, start);
const after = html.slice(end + '</section>'.length);

html = before + waypointsSection + after;

const helpModal = `    <!-- Waypoints help modal -->
    <div id="waypointsHelpModal" class="modal hidden">
      <div class="modal-content">
        <div class="modal-header">
          <h3>How to use Waypoints</h3>
          <button type="button" class="modal-close" data-close aria-label="Close">×</button>
        </div>
        <div class="waypoints-help-body">
          <p>
            <strong>Build your route:</strong> tap <em>Drop</em> or <em>Search</em>, then press anywhere on the map to drop a stop, or find a business or landmark.
          </p>
          <p>
            <strong>Reorder or remove stops:</strong> open a waypoint from the list to edit details, or drag the handle to reorder. Delete removes the stop from your route.
          </p>
          <p>
            <strong>Undo & redo:</strong> the <em>Undo</em> and <em>Redo</em> buttons step back and forward through waypoint changes.
          </p>
          <p>
            <strong>Fit trip:</strong> tap <em>Fit trip</em> to zoom the map so your whole route is visible.
          </p>
          <div class="modal-actions">
            <button type="button" class="primary-btn" data-close>Got it</button>
          </div>
        </div>
      </div>
    </div>

`;

// Only insert help modal once
if (!html.includes('id="waypointsHelpModal"')) {
  const toastMarker = '    <!-- Toast notifications -->';
  if (!html.includes(toastMarker)) throw new Error('Toast notifications marker not found');
  html = html.replace(toastMarker, helpModal + toastMarker);
}

fs.writeFileSync(file, html);
console.log('Waypoints panel SVGs repaired and help modal inserted.');
