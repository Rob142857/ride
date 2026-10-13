const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Classes {
  values = new Set(['hidden']);
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
}

function eventTarget(extra = {}) {
  const listeners = {};
  return {
    listeners,
    addEventListener(type, callback) { listeners[type] = callback; },
    ...extra
  };
}

const rows = ['a', 'b', 'c', 'd'].map(id => ({ dataset: { id } }));
const container = { querySelectorAll: () => rows };
const persistedOrders = [];
const focusReturns = [];
const input = eventTarget({
  value: '', min: '', max: '', attributes: {},
  focus() { this.focused = true; },
  setAttribute(name, value) { this.attributes[name] = value; },
  removeAttribute(name) { delete this.attributes[name]; }
});
const error = { textContent: '', classList: new Classes() };
const description = { textContent: '' };
const form = eventTarget({ dataset: {}, reset() {} });
const closeButtons = [eventTarget()];
const modal = eventTarget({
  dataset: {}, classList: new Classes(),
  querySelectorAll: () => closeButtons,
  removeAttribute(name) { if (name === 'data-waypoint-id') delete this.dataset.waypointId; }
});
const elements = {
  waypointsList: container,
  waypointPositionModal: modal,
  waypointPositionDescription: description,
  waypointPositionInput: input,
  waypointPositionForm: form,
  waypointPositionError: error
};
const UI = {
  showToast() {},
  openModal(id) { elements[id].classList.remove('hidden'); },
  closeModal(id) { elements[id].classList.add('hidden'); }
};
const context = {
  UI,
  App: { reorderWaypoints: order => persistedOrders.push(order) },
  document: { getElementById: id => elements[id] || null, activeElement: null }
};

vm.runInNewContext(fs.readFileSync('public/js/ui-renderers.js', 'utf8'), context);

assert.deepEqual(Array.from(UI.orderWaypointAtPosition(['a', 'b', 'c', 'd'], 'a', 4)), ['b', 'c', 'd', 'a']);
assert.deepEqual(Array.from(UI.orderWaypointAtPosition(['a', 'b', 'c', 'd'], 'd', 1)), ['d', 'a', 'b', 'c']);
assert.equal(UI.orderWaypointAtPosition(['a', 'b', 'c', 'd'], 'd', 0), null);
assert.equal(UI.orderWaypointAtPosition(['a', 'b', 'c', 'd'], 'd', 5), null);
assert.equal(UI.orderWaypointAtPosition(['a', 'b', 'c', 'd'], 'missing', 2), null);

const cancelFocus = { focus() { focusReturns.push('cancel'); } };
assert.equal(UI.requestWaypointPosition('d', 'Waypoint D', cancelFocus), true);
assert.equal(modal.classList.contains('hidden'), false);
assert.equal(input.value, '4');
assert.match(description.textContent, /1 to 4/);
closeButtons[0].listeners.click();
assert.equal(modal.classList.contains('hidden'), true);
assert.equal(persistedOrders.length, 0);
assert.deepEqual(focusReturns, ['cancel']);

UI.requestWaypointPosition('d', 'Waypoint D');
input.value = '0';
assert.equal(UI.submitWaypointPosition(), false);
assert.equal(modal.classList.contains('hidden'), false);
assert.match(error.textContent, /1 to 4/);
input.value = '5';
assert.equal(UI.submitWaypointPosition(), false);
assert.equal(persistedOrders.length, 0);

input.value = '3';
assert.equal(UI.submitWaypointPosition(), true);
assert.equal(modal.classList.contains('hidden'), true);
assert.deepEqual(Array.from(persistedOrders[0]), ['a', 'b', 'd', 'c']);
assert.deepEqual(Array.from(persistedOrders[0]).sort(), ['a', 'b', 'c', 'd']);

console.log('Waypoint reorder position checks passed');
