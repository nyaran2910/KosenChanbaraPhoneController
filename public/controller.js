(() => {
  "use strict";

  // The tested phone pose defines the controller's canonical coordinates.
  // UI directions are additional user adjustments relative to that baseline,
  // so the expected pose is displayed as "positive" on every axis.
  const AXES = Object.freeze(["x", "y", "z"]);
  const DEFAULT_AXIS_MAPPING = Object.freeze({ x: "x", y: "z", z: "y" });
  const CANONICAL_AXIS_DIRECTION = Object.freeze({ x: -1, y: -1, z: 1 });
  const DEFAULT_AXIS_DIRECTION = Object.freeze({ x: 1, y: 1, z: 1 });
  const DEFAULT_AXIS_ADJUSTMENT = Object.freeze({ x: 0, y: 0, z: 0 });
  const AXIS_STORAGE_KEY = "kosen-chanbara-axis-adjustment-v4";
  const params = new URLSearchParams(location.search);
  const session = params.get("session") || "";
  const slot = params.get("slot") || "";
  const token = params.get("token") || "";
  const playerElement = document.getElementById("player");
  const startButton = document.getElementById("start");
  const guardButton = document.getElementById("guard");
  const recenterButton = document.getElementById("recenter");
  const axisInputs = Object.fromEntries(
    AXES.map(axis => [axis, document.getElementById(`axis-${axis}`)])
  );
  const axisOutputs = Object.fromEntries(
    AXES.map(axis => [axis, document.getElementById(`axis-${axis}-value`)])
  );
  const axisMappingInputs = Object.fromEntries(
    AXES.map(axis => [axis, document.getElementById(`axis-map-${axis}`)])
  );
  const axisDirectionButtons = Object.fromEntries(
    AXES.map(axis => [axis, document.querySelector(`.direction-toggle[data-axis="${axis}"]`)])
  );
  const savedAxisConfiguration = loadAxisConfiguration();

  const state = {
    socket: null,
    peer: null,
    channel: null,
    pendingCandidates: [],
    remoteDescriptionSet: false,
    guard: false,
    sequence: 0,
    recenterSequence: 0,
    orientation: [0, 0, 0, 1],
    orientationValid: false,
    gyroscope: [0, 0, 0],
    gyroscopeValid: false,
    acceleration: [0, 0, 0],
    accelerationValid: false,
    axisMapping: savedAxisConfiguration.mapping,
    axisDirection: savedAxisConfiguration.direction,
    axisAdjustment: savedAxisConfiguration.adjustment,
    sendTimer: 0,
    connectionTimeout: 0,
    reconnectTimer: 0,
    disconnectTimer: 0,
    reconnectAttempt: 0,
    sensorsAttached: false,
    started: false,
    shuttingDown: false,
    wakeLock: null
  };

  initializeAxisControls();
  playerElement.textContent = slot.toUpperCase() || "--";
  if (!session || !token || (slot !== "p1" && slot !== "p2")) {
    startButton.disabled = true;
    return;
  }

  startButton.addEventListener("click", start);
  recenterButton.addEventListener("click", recenter);
  guardButton.addEventListener("pointerdown", event => {
    event.preventDefault();
    guardButton.setPointerCapture?.(event.pointerId);
    setGuard(true);
  });
  guardButton.addEventListener("contextmenu", event => event.preventDefault());
  for (const eventName of ["pointerup", "pointercancel", "lostpointercapture"]) {
    guardButton.addEventListener(eventName, () => setGuard(false));
  }
  window.addEventListener("blur", () => setGuard(false));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) setGuard(false);
    else void requestWakeLock();
  });
  window.addEventListener("pagehide", shutdown);

  async function start() {
    startButton.disabled = true;
    try {
      await requestSensorPermission();
      attachSensors();
      await requestWakeLock();
      state.started = true;
      state.shuttingDown = false;
      connectSignaling();
    } catch (error) {
      console.error(error);
      state.started = false;
      startButton.disabled = false;
    }
  }

  async function requestSensorPermission() {
    for (const sensorType of [window.DeviceOrientationEvent, window.DeviceMotionEvent]) {
      if (sensorType && typeof sensorType.requestPermission === "function") {
        const permission = await sensorType.requestPermission();
        if (permission !== "granted") throw new Error("sensor permission denied");
      }
    }
  }

  function attachSensors() {
    if (state.sensorsAttached) return;
    state.sensorsAttached = true;
    window.addEventListener("deviceorientation", event => {
      if (event.alpha == null || event.beta == null || event.gamma == null) return;
      state.orientation = deviceQuaternion(event.alpha, event.beta, event.gamma, screenAngle());
      state.orientationValid = true;
    }, true);

    window.addEventListener("devicemotion", event => {
      const rotation = event.rotationRate;
      if (rotation && finite(rotation.beta) && finite(rotation.gamma) && finite(rotation.alpha)) {
        state.gyroscope = rotateScreen(rotation.beta, rotation.gamma, rotation.alpha, screenAngle());
        state.gyroscopeValid = true;
      }
      const acceleration = event.acceleration;
      if (acceleration && finite(acceleration.x) && finite(acceleration.y) && finite(acceleration.z)) {
        state.acceleration = rotateScreen(acceleration.x, acceleration.y, acceleration.z, screenAngle());
        state.accelerationValid = true;
      }
    }, true);
  }

  function connectSignaling() {
    if (!state.started || state.shuttingDown) return;
    if (state.socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(state.socket.readyState)) return;
    if (state.reconnectTimer) window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = 0;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/signal`);
    state.socket = socket;
    armConnectionTimeout();

    socket.addEventListener("open", () => {
      if (state.socket === socket) sendSignal({ type: "peer.join", session, slot, token });
    });
    socket.addEventListener("message", event => {
      if (state.socket !== socket) return;
      void handleSignal(event.data).catch(error => {
        console.error(error);
        recoverConnection();
      });
    });
    socket.addEventListener("close", () => {
      if (state.socket !== socket) return;
      state.socket = null;
      // WSS is only needed to negotiate the connection. Keep an established
      // phone-to-PC data channel usable during a signaling/VPS outage.
      if (isOpen()) return;
      recoverConnection();
    });
  }

  async function handleSignal(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }

    if (message.type === "peer.ready") {
      return;
    }
    if (message.type === "rtc.offer" && message.slot === slot) {
      await acceptOffer(message.sdp);
      return;
    }
    if (message.type === "rtc.candidate" && message.slot === slot) {
      const candidate = message.candidate;
      if (!candidate?.candidate) return;
      if (state.remoteDescriptionSet && state.peer) await state.peer.addIceCandidate(candidate);
      else state.pendingCandidates.push(candidate);
      return;
    }
    if (message.type === "error") console.error(message.message || "signaling error");
  }

  async function acceptOffer(sdp) {
    const earlyCandidates = state.pendingCandidates.splice(0);
    shutdownPeer();
    const peer = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });
    state.peer = peer;
    state.remoteDescriptionSet = false;
    armConnectionTimeout();

    peer.addEventListener("icecandidate", event => {
      if (state.peer !== peer) return;
      const candidate = event.candidate;
      if (!candidate) return;
      sendSignal({ type: "rtc.candidate", slot, candidate: candidate.toJSON() });
    });
    peer.addEventListener("datachannel", event => {
      if (state.peer === peer) configureChannel(event.channel);
    });
    peer.addEventListener("iceconnectionstatechange", () => {
      if (state.peer !== peer) return;
      if (["connected", "completed"].includes(peer.iceConnectionState)) {
        clearDisconnectTimer();
      } else if (peer.iceConnectionState === "disconnected") {
        clearDisconnectTimer();
        state.disconnectTimer = window.setTimeout(() => {
          if (state.peer === peer && peer.iceConnectionState === "disconnected") recoverConnection();
        }, 2000);
      } else if (["failed", "closed"].includes(peer.iceConnectionState)) {
        recoverConnection();
      }
    });

    await peer.setRemoteDescription({ type: "offer", sdp });
    if (state.peer !== peer) return;
    state.remoteDescriptionSet = true;
    for (const candidate of [...earlyCandidates, ...state.pendingCandidates.splice(0)]) {
      await peer.addIceCandidate(candidate);
    }
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    if (state.peer !== peer) return;
    sendSignal({ type: "rtc.answer", slot, sdp: answer.sdp });
  }

  function configureChannel(channel) {
    state.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.addEventListener("open", () => {
      if (state.channel !== channel) return;
      clearConnectionTimeout();
      clearDisconnectTimer();
      if (state.reconnectTimer) window.clearTimeout(state.reconnectTimer);
      state.reconnectTimer = 0;
      state.reconnectAttempt = 0;
      guardButton.disabled = false;
      recenterButton.disabled = false;
      if (state.sendTimer) window.clearInterval(state.sendTimer);
      sendMotion();
      state.sendTimer = window.setInterval(sendMotion, 15);
    });
    channel.addEventListener("close", () => {
      if (state.channel === channel) recoverConnection();
    });
  }

  function sendMotion() {
    if (!isOpen()) return;
    const correction = axisAdjustmentQuaternion();
    const inverseCorrection = inverseQuaternion(correction);
    const angleAdjustedOrientation = normalizeQuaternion(multiplyQuaternion(state.orientation, correction));
    const angleAdjustedGyroscope = rotateVectorByQuaternion(state.gyroscope, inverseCorrection);
    const angleAdjustedAcceleration = rotateVectorByQuaternion(state.acceleration, inverseCorrection);
    const adjustedOrientation = remapQuaternion(angleAdjustedOrientation);
    const adjustedGyroscope = remapAxialVector(angleAdjustedGyroscope);
    const adjustedAcceleration = remapVector(angleAdjustedAcceleration);
    // Motion packets stay fixed at 56 bytes. RecenterSequence is repeated in
    // every packet so an unreliable low-latency DataChannel cannot lose the
    // command permanently.
    const bytes = new ArrayBuffer(56);
    const view = new DataView(bytes);
    let flags = state.guard ? 1 : 0;
    if (state.orientationValid) flags |= 2;
    if (state.gyroscopeValid) flags |= 4;
    if (state.accelerationValid) flags |= 8;
    view.setUint8(0, 1);
    view.setUint8(1, flags);
    view.setUint16(2, state.recenterSequence, true);
    view.setUint32(4, state.sequence++ >>> 0, true);
    view.setFloat64(8, performance.now(), true);
    writeVector(view, 16, adjustedOrientation, 4);
    writeVector(view, 32, adjustedGyroscope, 3);
    writeVector(view, 44, adjustedAcceleration, 3);
    try { state.channel.send(bytes); } catch { /* state changes asynchronously */ }
  }

  function setGuard(held) {
    if (state.guard === held) return;
    state.guard = held;
    sendMotion();
  }

  function recenter() {
    if (!isOpen()) return;
    state.recenterSequence = (state.recenterSequence + 1) & 0xffff;
    sendMotion();
  }

  function isOpen() {
    return state.channel?.readyState === "open";
  }

  function sendSignal(message) {
    if (state.socket?.readyState !== WebSocket.OPEN) return;
    try { state.socket.send(JSON.stringify(message)); } catch { /* close race */ }
  }

  function shutdownPeer() {
    clearConnectionTimeout();
    clearDisconnectTimer();
    if (state.sendTimer) window.clearInterval(state.sendTimer);
    state.sendTimer = 0;
    const channel = state.channel;
    const peer = state.peer;
    state.channel = null;
    state.peer = null;
    state.remoteDescriptionSet = false;
    state.pendingCandidates.length = 0;
    channel?.close();
    peer?.close();
  }

  function closeSignaling() {
    const socket = state.socket;
    state.socket = null;
    try {
      socket?.close();
    } catch { /* already closing */ }
  }

  function recoverConnection() {
    if (!state.started || state.shuttingDown) return;
    state.guard = false;
    guardButton.disabled = true;
    recenterButton.disabled = true;
    shutdownPeer();
    closeSignaling();
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (!state.started || state.shuttingDown || state.reconnectTimer) return;
    const delay = Math.min(2000, 250 * (2 ** state.reconnectAttempt));
    state.reconnectAttempt = Math.min(state.reconnectAttempt + 1, 3);
    state.reconnectTimer = window.setTimeout(() => {
      state.reconnectTimer = 0;
      connectSignaling();
    }, delay);
  }

  function armConnectionTimeout() {
    clearConnectionTimeout();
    state.connectionTimeout = window.setTimeout(() => {
      if (!isOpen()) recoverConnection();
    }, 8000);
  }

  function clearConnectionTimeout() {
    if (state.connectionTimeout) window.clearTimeout(state.connectionTimeout);
    state.connectionTimeout = 0;
  }

  function clearDisconnectTimer() {
    if (state.disconnectTimer) window.clearTimeout(state.disconnectTimer);
    state.disconnectTimer = 0;
  }

  function shutdown() {
    state.shuttingDown = true;
    state.started = false;
    if (state.reconnectTimer) window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = 0;
    setGuard(false);
    shutdownPeer();
    closeSignaling();
    state.wakeLock?.release?.();
  }

  async function requestWakeLock() {
    try {
      if ("wakeLock" in navigator && !document.hidden) state.wakeLock = await navigator.wakeLock.request("screen");
    } catch { /* not supported or denied */ }
  }

  function finite(value) { return typeof value === "number" && Number.isFinite(value); }
  function degrees(value) { return value * Math.PI / 180; }

  function initializeAxisControls() {
    for (const axis of AXES) {
      axisInputs[axis].value = String(state.axisAdjustment[axis]);
      axisInputs[axis].addEventListener("input", event => {
        updateAxisAdjustment(axis, Number(event.currentTarget.value));
      });
      axisMappingInputs[axis].addEventListener("change", event => {
        updateAxisMapping(axis, event.currentTarget.value);
      });
      axisDirectionButtons[axis].addEventListener("click", () => {
        state.axisDirection[axis] *= -1;
        saveAxisConfiguration();
        renderAxisAdjustment();
        sendMotion();
      });
    }
    for (const button of document.querySelectorAll(".axis-step")) {
      button.addEventListener("click", () => {
        const axis = button.dataset.axis;
        updateAxisAdjustment(axis, state.axisAdjustment[axis] + Number(button.dataset.step));
      });
    }
    renderAxisAdjustment();
  }

  function updateAxisAdjustment(axis, value) {
    if (!(axis in state.axisAdjustment) || !finite(value)) return;
    state.axisAdjustment[axis] = Math.max(-180, Math.min(180, Math.round(value / 5) * 5));
    saveAxisConfiguration();
    renderAxisAdjustment();
    sendMotion();
  }

  function updateAxisMapping(outputAxis, sourceAxis) {
    if (!AXES.includes(outputAxis) || !AXES.includes(sourceAxis)) return;
    const previousSource = state.axisMapping[outputAxis];
    const swappedOutput = AXES.find(axis => axis !== outputAxis && state.axisMapping[axis] === sourceAxis);
    state.axisMapping[outputAxis] = sourceAxis;
    if (swappedOutput) state.axisMapping[swappedOutput] = previousSource;
    saveAxisConfiguration();
    renderAxisAdjustment();
    sendMotion();
  }

  function renderAxisAdjustment() {
    for (const axis of AXES) {
      const value = state.axisAdjustment[axis];
      axisInputs[axis].value = String(value);
      axisOutputs[axis].textContent = `${value}°`;
      axisMappingInputs[axis].value = state.axisMapping[axis];
      const inverted = state.axisDirection[axis] < 0;
      axisDirectionButtons[axis].textContent = inverted ? "− 反転" : "＋ 正方向";
      axisDirectionButtons[axis].setAttribute("aria-pressed", String(inverted));
    }
  }

  function loadAxisConfiguration() {
    try {
      const saved = JSON.parse(localStorage.getItem(AXIS_STORAGE_KEY));
      return saved ? normalizeAxisConfiguration(saved) : defaultAxisConfiguration();
    } catch {
      return defaultAxisConfiguration();
    }
  }

  function normalizeAxisConfiguration(saved) {
    const proposedMapping = Object.fromEntries(AXES.map(axis => [axis, saved?.mapping?.[axis]]));
    const validMapping = AXES.every(axis => AXES.includes(proposedMapping[axis]))
      && new Set(Object.values(proposedMapping)).size === AXES.length;
    const mapping = validMapping ? proposedMapping : { ...DEFAULT_AXIS_MAPPING };
    const direction = Object.fromEntries(AXES.map(axis => {
      const value = Number(saved?.direction?.[axis]);
      return [axis, value === -1 || value === 1 ? value : DEFAULT_AXIS_DIRECTION[axis]];
    }));
    const adjustmentSource = saved?.adjustment ?? saved;
    const adjustment = Object.fromEntries(AXES.map(axis => {
      const value = Number(adjustmentSource?.[axis]);
      const normalized = finite(value)
        ? Math.max(-180, Math.min(180, Math.round(value / 5) * 5))
        : DEFAULT_AXIS_ADJUSTMENT[axis];
      return [axis, normalized];
    }));
    return { mapping, direction, adjustment };
  }

  function defaultAxisConfiguration() {
    return {
      mapping: { ...DEFAULT_AXIS_MAPPING },
      direction: { ...DEFAULT_AXIS_DIRECTION },
      adjustment: { ...DEFAULT_AXIS_ADJUSTMENT }
    };
  }

  function saveAxisConfiguration() {
    try {
      localStorage.setItem(AXIS_STORAGE_KEY, JSON.stringify({
        mapping: state.axisMapping,
        direction: state.axisDirection,
        adjustment: state.axisAdjustment
      }));
    } catch { /* optional */ }
  }

  function axisAdjustmentQuaternion() {
    const x = axisQuaternion(1, 0, 0, degrees(state.axisAdjustment.x));
    const y = axisQuaternion(0, 1, 0, degrees(state.axisAdjustment.y));
    const z = axisQuaternion(0, 0, 1, degrees(state.axisAdjustment.z));
    return normalizeQuaternion(multiplyQuaternion(multiplyQuaternion(x, y), z));
  }

  function deviceQuaternion(alpha, beta, gamma, orientation) {
    const qy = axisQuaternion(0, 1, 0, degrees(alpha));
    const qx = axisQuaternion(1, 0, 0, degrees(beta));
    const qz = axisQuaternion(0, 0, 1, -degrees(gamma));
    const cameraCorrection = axisQuaternion(1, 0, 0, -Math.PI / 2);
    const screenCorrection = axisQuaternion(0, 0, 1, -degrees(orientation));
    return normalizeQuaternion(multiplyQuaternion(multiplyQuaternion(multiplyQuaternion(qy, qx), qz), multiplyQuaternion(cameraCorrection, screenCorrection)));
  }

  function axisQuaternion(x, y, z, angle) {
    const half = angle / 2;
    const sine = Math.sin(half);
    return [x * sine, y * sine, z * sine, Math.cos(half)];
  }

  function multiplyQuaternion(a, b) {
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
    ];
  }

  function normalizeQuaternion(q) {
    const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return q.map(value => value / length);
  }

  function inverseQuaternion(q) {
    return [-q[0], -q[1], -q[2], q[3]];
  }

  function rotateVectorByQuaternion(vector, quaternion) {
    const vectorQuaternion = [vector[0], vector[1], vector[2], 0];
    const rotated = multiplyQuaternion(
      multiplyQuaternion(quaternion, vectorQuaternion),
      inverseQuaternion(quaternion)
    );
    return rotated.slice(0, 3);
  }

  function remapVector(vector) {
    return AXES.map(outputAxis => {
      const sourceIndex = AXES.indexOf(state.axisMapping[outputAxis]);
      return effectiveAxisDirection(outputAxis) * vector[sourceIndex];
    });
  }

  function remapAxialVector(vector) {
    const determinant = mappingDeterminant();
    return remapVector(vector).map(value => determinant * value);
  }

  function effectiveAxisDirection(outputAxis) {
    return CANONICAL_AXIS_DIRECTION[outputAxis] * state.axisDirection[outputAxis];
  }

  function remapQuaternion(quaternion) {
    const determinant = mappingDeterminant();
    const vector = remapVector(quaternion.slice(0, 3));
    return normalizeQuaternion([
      determinant * vector[0],
      determinant * vector[1],
      determinant * vector[2],
      quaternion[3]
    ]);
  }

  function mappingDeterminant() {
    const matrix = AXES.map(outputAxis => AXES.map(sourceAxis =>
      state.axisMapping[outputAxis] === sourceAxis ? effectiveAxisDirection(outputAxis) : 0
    ));
    return matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1])
      - matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0])
      + matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0]);
  }

  function rotateScreen(x, y, z, angle) {
    const radians = -degrees(angle);
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    return [x * cosine - y * sine, x * sine + y * cosine, z];
  }

  function screenAngle() {
    return screen.orientation?.angle ?? window.orientation ?? 0;
  }

  function writeVector(view, offset, values, count) {
    for (let index = 0; index < count; index += 1) view.setFloat32(offset + index * 4, values[index] || 0, true);
  }
})();
