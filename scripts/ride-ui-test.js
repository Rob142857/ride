const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Classes {
  values = new Set(['hidden']);
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
}

function element(id) {
  return {
    id,
    textContent: '',
    dataset: {},
    classList: new Classes(),
    onclick: null,
    parentElement: null
  };
}

function loadUI() {
  const elements = Object.fromEntries([
    'rideRecordingStatus', 'rideDeviationBanner', 'rideDeviationText',
    'rideDeviationUpdate', 'rideDeviationKeep', 'rideUndoBanner',
    'rideUndoText', 'rideUndoButton'
  ].map(id => [id, element(id)]));
  elements.rideRecordingStatus.parentElement = element('rideHudStatus');
  const timers = new Map();
  let nextTimer = 1;
  const window = {
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); }
  };
  const context = {
    document: { getElementById: id => elements[id] || null },
    window,
    String,
    Number,
    console
  };
  vm.runInNewContext(fs.readFileSync('public/js/ride-ride-ui.js', 'utf8'), context);
  return { ui: window.RideRideUI, elements, timers };
}

{
  const { ui, elements } = loadUI();
  for (const [label, state] of [
    ['Recording', 'recording'], ['Paused', 'paused'],
    ['Waiting for GPS', 'waiting'], ['Sync pending', 'sync']
  ]) {
    ui.setRecordingStatus(label);
    assert.equal(elements.rideRecordingStatus.textContent, label);
    assert.equal(elements.rideRecordingStatus.parentElement.dataset.state, state);
  }
  ui.setRecordingStatus('<img src=x>');
  assert.equal(elements.rideRecordingStatus.textContent, '<img src=x>');
  assert.equal(elements.rideRecordingStatus.parentElement.dataset.state, 'recording');
}

{
  const { ui, elements } = loadUI();
  let updated = 0;
  let kept = 0;
  ui.showDeviation({ text: '<b>Choose</b>', onUpdate: () => updated++, onKeep: () => kept++ });
  assert.equal(elements.rideDeviationText.textContent, '<b>Choose</b>');
  assert.equal(elements.rideDeviationBanner.classList.contains('hidden'), false);
  elements.rideDeviationUpdate.onclick();
  assert.equal(updated, 1);
  assert.equal(kept, 0);
  assert.equal(elements.rideDeviationBanner.classList.contains('hidden'), true);
  assert.equal(elements.rideDeviationUpdate.onclick, null);
  ui.showDeviation({ onKeep: () => kept++ });
  elements.rideDeviationKeep.onclick();
  assert.equal(kept, 1);
  assert.match(elements.rideDeviationText.textContent, /Taking a different road/);
}

{
  const { ui, elements, timers } = loadUI();
  let undone = 0;
  ui.showUndo({ onUndo: () => undone++ });
  assert.equal(elements.rideUndoText.textContent, 'Guidance updated');
  ui.showUndo({ text: 'Waypoint removed', onUndo: () => undone++ });
  assert.equal(elements.rideUndoText.textContent, 'Waypoint removed');
  assert.equal(elements.rideUndoBanner.classList.contains('hidden'), false);
  const [[timerId, timer]] = [...timers.entries()];
  assert.equal(timer.delay, 10000);
  elements.rideUndoButton.onclick();
  assert.equal(undone, 1);
  assert.equal(elements.rideUndoBanner.classList.contains('hidden'), true);
  assert.equal(timers.has(timerId), false);

  ui.showUndo({ onUndo: () => undone++ });
  const timeout = [...timers.values()][0];
  timeout.callback();
  assert.equal(elements.rideUndoBanner.classList.contains('hidden'), true);
  assert.equal(undone, 1);
}

{
  const html = fs.readFileSync('public/index.html', 'utf8');
  assert.match(html, /id="rideDeviationUpdate"[^>]*>Update</);
  assert.match(html, /id="rideDeviationKeep"[^>]*>Keep plan</);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.doesNotMatch(html, /id="ride(Pause|Finish)Btn"/);
}

console.log('Ride UI checks passed');
