import { d as derived, w as writable } from "./index.js";
const initial$2 = {
  view: "map",
  modal: null,
  modalData: null,
  sideMenuOpen: false,
  toasts: [],
  landingSeen: localStorage.getItem("ride_landing_seen") === "1"
};
const uiStore = writable(initial$2);
const uiState = uiStore;
const currentView = derived(uiStore, ($u) => $u.view);
derived(uiStore, ($u) => $u.modal);
derived(uiStore, ($u) => $u.modalData);
derived(uiStore, ($u) => $u.sideMenuOpen);
derived(uiStore, ($u) => $u.toasts);
derived(uiStore, ($u) => $u.landingSeen);
const initial$1 = { current: null, list: [], loading: false, listLoading: false };
const tripStore = writable(initial$1);
const tripState = tripStore;
const currentTrip = derived(tripStore, ($t) => $t.current);
derived(tripStore, ($t) => $t.list);
derived(tripStore, ($t) => $t.loading);
const initial = {
  ready: false,
  isAddingWaypoint: false,
  routeData: null,
  ride: {
    active: false,
    position: null,
    heading: null,
    speed: null,
    nextInstruction: null,
    distanceToNext: 0,
    visitedWaypoints: /* @__PURE__ */ new Set(),
    offRouteCount: 0,
    rerouting: false
  }
};
const mapStore = writable(initial);
const mapState = mapStore;
derived(mapStore, ($m) => $m.ready);
derived(mapStore, ($m) => $m.isAddingWaypoint);
derived(mapStore, ($m) => $m.routeData);
const isRiding = derived(mapStore, ($m) => $m.ride.active);
derived(mapStore, ($m) => $m.ride);
export {
  currentView as a,
  currentTrip as c,
  isRiding as i,
  mapState as m,
  tripState as t,
  uiState as u
};
