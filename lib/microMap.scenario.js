/*! microMap.scenario.js v0.1.0 | MIT */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root, require('./microMap.js'));
  else root.microMapScenario = factory(root, root.microMap);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, microMap) {
  'use strict';

  var MAX_DURATION = 7 * 24 * 60 * 60 * 1000;
  function fail(message) { throw new Error('microMap.scenario: ' + message); }
  function finite(value, fallback) { value = +value; return isFinite(value) ? value : fallback; }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function copy(value, depth) {
    depth = depth || 0;
    if (depth > 16) fail('scenario values are nested too deeply');
    if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') { if (!isFinite(value)) fail('scenario values must be finite'); return value; }
    if (Array.isArray(value)) return value.map(function (item) { return copy(item, depth + 1); });
    if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('scenario values must be JSON-compatible');
    var result = {};
    for (var key in value) if (Object.prototype.hasOwnProperty.call(value, key)) Object.defineProperty(result, key, {
      value: copy(value[key], depth + 1), enumerable: true, configurable: true, writable: true
    });
    return result;
  }
  function timeValue(value, name) {
    var time = +value;
    if (!isFinite(time) || time < 0 || time > MAX_DURATION) fail(name + ' must be milliseconds within seven days');
    return time;
  }
  function point(value, name) {
    if (!Array.isArray(value) || value.length < 2 || !isFinite(+value[0]) || !isFinite(+value[1]) || +value[0] < -180 || +value[0] > 180 || +value[1] < -90 || +value[1] > 90) fail(name + ' must be a WGS84 [longitude, latitude] pair');
    return [+value[0], +value[1]];
  }
  function entity(value) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id) fail('each entity needs a string id');
    var inputTrack = Array.isArray(value.track) ? value.track : value.position ? [{ time: 0, coordinates: value.position, status: value.status }] : null;
    if (!inputTrack || !inputTrack.length || inputTrack.length > 10000) fail('entity ' + value.id + ' needs 1–10,000 track keyframes or a position');
    var track = inputTrack.map(function (frame) {
      if (!frame || typeof frame !== 'object') fail('entity keyframes must be objects');
      return {
        time: timeValue(frame.time == null ? frame.t : frame.time, 'keyframe time'),
        coordinates: point(frame.coordinates || frame.position, 'keyframe coordinates'),
        status: frame.status == null ? null : String(frame.status),
        properties: frame.properties == null ? {} : copy(frame.properties)
      };
    }).sort(function (a, b) { return a.time - b.time; });
    for (var i = 1; i < track.length; i++) if (track[i].time === track[i - 1].time) fail('entity keyframe times must be unique');
    return { id: value.id, type: String(value.type || 'entity'), properties: copy(value.properties || {}), track: track };
  }
  function scenarioEvent(value, index) {
    if (!value || typeof value !== 'object') fail('events must be objects');
    var id = value.id == null ? 'event-' + index : String(value.id);
    if (!id) fail('event ids cannot be empty');
    return {
      id: id,
      time: timeValue(value.time == null ? value.t : value.time, 'event time'),
      type: String(value.type || 'notice'),
      title: String(value.title || value.message || value.type || 'Event'),
      properties: copy(value.properties || {}),
      coordinates: value.coordinates == null ? null : point(value.coordinates, 'event coordinates')
    };
  }
  function normalize(input) {
    if (!input || typeof input !== 'object') fail('scenario must be an object');
    if (input.version != null && input.version !== 1) fail('unsupported scenario version');
    var entities = input.entities == null ? [] : input.entities;
    var events = input.events == null ? [] : input.events;
    if (!Array.isArray(entities) || entities.length > 10000) fail('scenario supports up to 10,000 entities');
    if (!Array.isArray(events) || events.length > 50000) fail('scenario supports up to 50,000 events');
    var entityIds = Object.create(null);
    var normalizedEntities = entities.map(function (value) {
      var next = entity(value);
      if (entityIds[next.id]) fail('duplicate entity id ' + next.id);
      entityIds[next.id] = true;
      return next;
    });
    var eventIds = Object.create(null);
    var normalizedEvents = events.map(function (value, index) {
      var next = scenarioEvent(value, index + 1);
      if (eventIds[next.id]) fail('duplicate event id ' + next.id);
      eventIds[next.id] = true;
      return next;
    }).sort(function (a, b) { return a.time - b.time || a.id.localeCompare(b.id); });
    var latest = 0;
    normalizedEntities.forEach(function (item) { latest = Math.max(latest, item.track[item.track.length - 1].time); });
    normalizedEvents.forEach(function (item) { latest = Math.max(latest, item.time); });
    var duration = input.duration == null ? latest : timeValue(input.duration, 'duration');
    if (duration < latest) fail('duration cannot end before an entity or event');
    return { version: 1, id: input.id == null ? null : String(input.id), title: String(input.title || 'Scenario'), duration: duration, entities: normalizedEntities, events: normalizedEvents };
  }

  function create(input, options) {
    options = options || {};
    var scenario = normalize(input || {});
    var now = root.performance && root.performance.now ? function () { return root.performance.now(); } : function () { return Date.now(); };
    var requestFrame = root.requestAnimationFrame || function (fn) { return root.setTimeout(function () { fn(now()); }, 16); };
    var cancelFrame = root.cancelAnimationFrame || root.clearTimeout;
    var listeners = Object.create(null);
    var time = clamp(finite(options.time, 0), 0, scenario.duration);
    var speed = clamp(finite(options.speed, 1), 0.05, 100);
    var playing = false;
    var destroyed = false;
    var frame = 0;
    var lastFrame = 0;
    var nextEventId = 1;

    function emit(type, extra) {
      var list = listeners[type];
      if (!list || !list.length) return;
      var event = { type: type, target: api, time: time, duration: scenario.duration };
      if (extra) for (var key in extra) event[key] = extra[key];
      list.slice().forEach(function (handler) { handler(event); });
    }
    function on(type, handler) {
      if (!destroyed && typeof handler === 'function') (listeners[type] || (listeners[type] = [])).push(handler);
      return api;
    }
    function off(type, handler) {
      var list = listeners[type];
      if (!list) return api;
      if (!handler) delete listeners[type];
      else { var index = list.indexOf(handler); if (index >= 0) list.splice(index, 1); }
      return api;
    }
    function snapshot(at) {
      at = clamp(finite(at, time), 0, scenario.duration);
      var entities = [];
      for (var i = 0; i < scenario.entities.length; i++) {
        var item = scenario.entities[i];
        var track = item.track;
        if (at < track[0].time) continue;
        var left = 0;
        while (left + 1 < track.length && track[left + 1].time <= at) left++;
        var first = track[left];
        var second = track[left + 1];
        var coordinates = first.coordinates.slice();
        if (second && at < second.time) {
          var ratio = (at - first.time) / (second.time - first.time);
          var delta = second.coordinates[0] - first.coordinates[0];
          if (delta > 180) delta -= 360;
          if (delta < -180) delta += 360;
          coordinates[0] = ((first.coordinates[0] + delta * ratio + 540) % 360) - 180;
          coordinates[1] += (second.coordinates[1] - first.coordinates[1]) * ratio;
        }
        var properties = copy(item.properties);
        var frameProperties = copy(first.properties);
        for (var name in frameProperties) properties[name] = frameProperties[name];
        entities.push({ id: item.id, type: item.type, coordinates: coordinates, status: first.status, properties: properties });
      }
      return { time: at, duration: scenario.duration, entities: entities, events: scenario.events.filter(function (entry) { return entry.time <= at; }).map(function (entry) { return copy(entry); }) };
    }
    function dispatchEvents(from, to) {
      if (to <= from) return;
      for (var i = 0; i < scenario.events.length; i++) {
        var event = scenario.events[i];
        if (event.time > from && event.time <= to) emit('event', { event: copy(event), snapshot: snapshot(event.time) });
      }
    }
    function setTime(next, settings) {
      if (destroyed) return api;
      settings = settings || {};
      var previous = time;
      time = clamp(finite(next, time), 0, scenario.duration);
      if (settings.events !== false && time > previous) dispatchEvents(previous, time);
      emit('time', { previousTime: previous, snapshot: snapshot() });
      emit('tick', { snapshot: snapshot() });
      if (playing && time >= scenario.duration) pause('complete');
      return api;
    }
    function tick(timestamp) {
      frame = 0;
      if (!playing || destroyed) return;
      var current = finite(timestamp, now());
      if (!lastFrame) lastFrame = current;
      var elapsed = Math.max(0, current - lastFrame);
      lastFrame = current;
      setTime(time + elapsed * speed);
      if (playing && !destroyed) frame = requestFrame.call(root, tick);
    }
    function play() {
      if (destroyed || playing || scenario.duration === 0) return api;
      if (time >= scenario.duration) setTime(0, { events: false });
      playing = true;
      lastFrame = 0;
      emit('play');
      frame = requestFrame.call(root, tick);
      return api;
    }
    function pause(reason) {
      if (!playing) return api;
      playing = false;
      if (frame) cancelFrame.call(root, frame);
      frame = 0;
      lastFrame = 0;
      emit('pause', { reason: reason || 'user' });
      return api;
    }
    function load(next) {
      if (destroyed) return api;
      var normalized = normalize(next);
      pause('scenario-change');
      scenario = normalized;
      time = 0;
      emit('scenariochange', { scenario: getScenario() });
      emit('time', { previousTime: 0, snapshot: snapshot() });
      dispatchEvents(-1, 0);
      emit('tick', { snapshot: snapshot() });
      return api;
    }
    function getScenario() { return copy(scenario); }
    function inject(value) {
      if (destroyed) return null;
      var source = copy(value || {});
      if (source.time == null && source.t == null) source.time = time;
      if (source.id == null) source.id = 'injected-' + nextEventId++;
      var event = scenarioEvent(source, nextEventId++);
      if (event.time > scenario.duration) fail('injected event cannot occur after scenario duration');
      if (scenario.events.some(function (existing) { return existing.id === event.id; })) fail('duplicate event id ' + event.id);
      if (scenario.events.length >= 50000) fail('scenario supports up to 50,000 events');
      scenario.events.push(event);
      scenario.events.sort(function (a, b) { return a.time - b.time || a.id.localeCompare(b.id); });
      emit('event', { event: copy(event), injected: true, snapshot: snapshot() });
      emit('scenariochange', { scenario: getScenario() });
      return copy(event);
    }
    function setEntityState(id, patch) {
      if (destroyed) return api;
      var item = scenario.entities.find(function (entry) { return entry.id === String(id); });
      if (!item) fail('unknown entity ' + String(id));
      if (!patch || typeof patch !== 'object') fail('entity state patch must be an object');
      var current = snapshot().entities.find(function (entry) { return entry.id === item.id; });
      var frameValue = { time: time, coordinates: patch.coordinates || patch.position || current && current.coordinates, status: patch.status == null ? current && current.status : String(patch.status), properties: copy(current ? current.properties : item.properties) };
      if (!frameValue.coordinates) fail('entity has no position at the current time');
      if (patch.properties != null) {
        frameValue.properties = copy(current ? current.properties : item.properties);
        var incoming = copy(patch.properties);
        for (var key in incoming) frameValue.properties[key] = incoming[key];
      }
      frameValue = entity({ id: item.id, type: item.type, properties: item.properties, track: item.track.filter(function (entry) { return entry.time !== time; }).concat([frameValue]) });
      scenario.entities[scenario.entities.indexOf(item)] = frameValue;
      emit('entitychange', { entity: copy(snapshot().entities.find(function (entry) { return entry.id === item.id; })) });
      emit('scenariochange', { scenario: getScenario() });
      emit('tick', { snapshot: snapshot() });
      return api;
    }
    function addEntity(value) {
      if (destroyed) return api;
      var next = entity(value);
      if (next.track[next.track.length - 1].time > scenario.duration) fail('entity keyframes cannot extend beyond scenario duration');
      if (scenario.entities.some(function (item) { return item.id === next.id; })) fail('duplicate entity id ' + next.id);
      if (scenario.entities.length >= 10000) fail('scenario supports up to 10,000 entities');
      scenario.entities.push(next);
      emit('scenariochange', { scenario: getScenario() });
      emit('tick', { snapshot: snapshot() });
      return api;
    }
    function removeEntity(id) {
      if (destroyed) return api;
      var index = scenario.entities.findIndex(function (item) { return item.id === String(id); });
      if (index >= 0) { scenario.entities.splice(index, 1); emit('scenariochange', { scenario: getScenario() }); emit('tick', { snapshot: snapshot() }); }
      return api;
    }
    function setSpeed(value) { if (destroyed) return api; speed = clamp(finite(value, speed), 0.05, 100); emit('speed', { speed: speed }); return api; }
    function destroy() {
      if (destroyed) return;
      pause('destroy');
      destroyed = true;
      if (frame) cancelFrame.call(root, frame);
      frame = 0;
      emit('destroy');
      listeners = Object.create(null);
    }

    var api = {
      on: on, off: off, load: load, getScenario: getScenario, toJSON: getScenario,
      getTime: function () { return time; }, getDuration: function () { return scenario.duration; },
      getSpeed: function () { return speed; }, isPlaying: function () { return playing; },
      getSnapshot: snapshot, seek: setTime, step: function (delta) { pause('step'); return setTime(time + finite(delta, 0)); },
      play: play, pause: pause, setSpeed: setSpeed, inject: inject,
      addEntity: addEntity, removeEntity: removeEntity, setEntityState: setEntityState, destroy: destroy
    };
    emit('scenariochange', { scenario: getScenario() });
    dispatchEvents(-1, time);
    return api;
  }

  create.normalize = normalize;
  create.MAX_DURATION = MAX_DURATION;
  if (typeof microMap === 'function' && !microMap.scenario) microMap.scenario = create;
  return create;
});
