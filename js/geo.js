/* ========== 地理围栏自动打卡 ========== */
const GeoPunch = (() => {
  let watchId = null;
  let inFenceCount = 0;      // 连续在圈内次数（防 GPS 漂移）
  let isInside = false;      // 当前是否判定在圈内
  let onEvent = null;        // 回调 (type, payload) => void

  function setHandler(fn) { onEvent = fn; }

  function emit(type, payload) { onEvent && onEvent(type, payload); }

  function handlePosition(pos) {
    const st = Store.settings;
    const f = st.fence;
    if (!f.lat && !f.lng) { emit('nofence'); return; }

    const dist = Salary.distance(pos.coords.latitude, pos.coords.longitude, f.lat, f.lng);
    const inside = dist <= f.radius;
    emit('dist', dist);

    if (inside) {
      inFenceCount++;
      if (!isInside && inFenceCount >= st.punchConfirmCount) {
        isInside = true;
        emit('enter');
      }
    } else {
      inFenceCount = 0;
      if (isInside) {
        isInside = false;
        emit('leave');
      }
    }
  }

  // http 网页（非 localhost）浏览器不给定位，自动打卡不可用——给出明确提示
  const insecureCtx = location.protocol !== 'https:'
    && !['localhost', '127.0.0.1'].includes(location.hostname);

  function handleError(err) {
    const map = { 1: '定位权限被拒绝，请允许定位', 2: '定位不可用', 3: '定位超时' };
    let msg = map[err.code] || '定位失败';
    if (insecureCtx && err.code === 1) {
      msg += '（http 网页浏览器不提供定位，自动打卡需 HTTPS 或装成 APP，可先用手动打卡）';
    }
    emit('error', msg);
  }

  function start() {
    if (watchId !== null || !navigator.geolocation) return;
    isInside = false; inFenceCount = 0;
    watchId = navigator.geolocation.watchPosition(handlePosition, handleError, {
      enableHighAccuracy: true, timeout: 15000, maximumAge: 5000
    });
    emit('started');
  }

  function stop() {
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    isInside = false; inFenceCount = 0;
    emit('stopped');
  }

  function running() { return watchId !== null; }

  return { setHandler, start, stop, running, isInside: () => isInside };
})();
