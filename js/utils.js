/*
 * utils.js — shared math, vectors and small helpers.
 * Everything hangs off the global EOTW namespace so the game runs from a
 * plain file:// open as well as from an http server (no module loader needed).
 */
window.EOTW = window.EOTW || {};

(function (G) {
  'use strict';

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

  // Axis-aligned bounding box overlap test.
  function aabb(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  // Point inside a rectangle.
  function pointInRect(px, py, rx, ry, rw, rh) {
    return px >= rx && px <= rx + rw && py >= ry && py <= ry + rh;
  }

  // Smooth easing used for camera and UI transitions.
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  G.util = { clamp, lerp, rand, dist, aabb, pointInRect, easeOut };
})(window.EOTW);
