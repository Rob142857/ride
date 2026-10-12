# Ride recording

Ride mode stores the actual GPS track separately from the original trip plan. When GPS goes off the planned route, Ride offers to update guidance to the next stop or keep the current guidance. The saved plan remains intact. After an update, an Undo option stays available for 10 seconds.

GPS fixes are checkpointed locally while recording, then uploaded as private ride logs. If the connection is unavailable, logs remain in a local queue and sync can retry later. Reloading recovers queued data; enter Ride again to resume recording. A gap longer than 30 seconds starts a separate track segment, so Ride does not draw a straight line across missing GPS data.

Ride automatically pauses after five minutes without meaningful movement within 35 metres. Reliable movement resumes recording as a new segment. Hiding the page or locking the screen pauses GPS recording; foregrounding Ride resumes automatically when the page remains open. After a reload, enter Ride as usual to continue. Ride mode keeps the existing Exit control and adds no Pause or Finish controls.

## Checks

Run the Ride behavior checks from the repository root:

```sh
node scripts/ride-account-test.js
node scripts/ride-data-test.js
node scripts/ride-map-test.js
node scripts/ride-navigation-test.js
node scripts/ride-recorder-test.js
node scripts/ride-session-test.js
node scripts/ride-ui-test.js
```

For a synthetic browser preview, run:

```sh
node scripts/ride-session-preview.js
```

Then open <http://127.0.0.1:3014/>. The preview uses synthetic trip, GPS, routing, and API responses on loopback only.
