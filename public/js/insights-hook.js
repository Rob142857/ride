/* Ride's semantic bridge to the shared Cloudflare Insights SDK. */
(function () {
  window.RideInsights = window.RideInsights || {
    track: function (event) {
      if (typeof window === 'undefined' || !event) return;
      window.dispatchEvent(new CustomEvent('rme:insight', { detail: { event: event } }));
    }
  };
}());
