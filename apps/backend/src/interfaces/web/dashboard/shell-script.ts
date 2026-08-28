/** The dashboard's browser half: fragment navigation, the publication list's
 * "load more", chart tooltips and the fingerprint poll that reloads a screen a
 * deploy has made stale. It sits in its own module rather than inside the shell
 * template so the shell stays a page skeleton one screen tall. */
export const SHELL_SCRIPT = `
  const loadMorePosts = async (button) => {
    const moreUrl = button.dataset.moreUrl;
    if (!moreUrl) {
      button.closest('.overview-publications')?.classList.add('overview-publications--expanded');
      button.remove();
      return;
    }
    if (button.dataset.loading === 'true') return;
    button.dataset.loading = 'true';
    button.disabled = true;
    try {
      const offset = Number(button.dataset.moreOffset || '0');
      const separator = moreUrl.includes('?') ? '&' : '?';
      const response = await fetch(moreUrl + separator + 'offset=' + encodeURIComponent(String(offset)) + '&limit=10', { credentials: 'same-origin' });
      const payload = await response.json();
      if (!response.ok || typeof payload.html !== 'string') throw new Error('publication details request failed');
      button.insertAdjacentHTML('beforebegin', payload.html);
      const loaded = Number(payload.loaded) || 0;
      const remaining = Number(payload.remaining) || 0;
      if (loaded === 0 || remaining === 0) {
        button.remove();
        return;
      }
      button.dataset.moreOffset = String(offset + loaded);
      const count = button.querySelector('span');
      if (count) count.textContent = String(remaining);
      button.disabled = false;
      delete button.dataset.loading;
    } catch {
      button.disabled = false;
      delete button.dataset.loading;
    }
  };
  // Membership has to live off the DOM: the fragment cache stores main.innerHTML,
  // so a "bound" marker written as an attribute is serialized with it and comes
  // back on elements that carry no listeners, leaving the restored screen inert.
  const bound = new WeakSet();
  const bindOnce = (element) => {
    if (bound.has(element)) return false;
    bound.add(element);
    return true;
  };
  const bindDashboardInteractions = (root) => {
    if (!root) return;
    root.querySelectorAll('.show-more-posts').forEach((button) => {
      if (!bindOnce(button)) return;
      button.addEventListener('click', () => void loadMorePosts(button));
    });
    const chartTooltip = root.querySelector('.overview-chart-tooltip');
    root.querySelectorAll('.chart-hit, [data-tooltip]').forEach((point) => {
      if (!bindOnce(point)) return;
      point.addEventListener('mouseenter', () => {
        if (!chartTooltip) return;
        chartTooltip.textContent = point.dataset.tooltip || '';
        chartTooltip.hidden = false;
      });
      point.addEventListener('mousemove', (event) => {
        if (!chartTooltip) return;
        chartTooltip.style.left = Math.min(event.clientX + 12, innerWidth - 280) + 'px';
        chartTooltip.style.top = (event.clientY + 12) + 'px';
      });
      point.addEventListener('mouseleave', () => {
        if (chartTooltip) chartTooltip.hidden = true;
      });
    });
  };
  bindDashboardInteractions(document.querySelector('main'));
  const navMenus = () => document.querySelectorAll('.nav-more[open], .period-menu[open]');
  document.addEventListener('click', (event) => {
    navMenus().forEach((menu) => {
      if (event.target instanceof Node && !menu.contains(event.target)) menu.removeAttribute('open');
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') navMenus().forEach((menu) => menu.removeAttribute('open'));
  });
  const fragmentCache = new Map();
  const fragmentRequests = new Map();
  const MAX_FRAGMENT_CACHE_ENTRIES = 5;
  const fragmentKey = (url) => url.pathname + url.search;
  const rememberFragment = (key, html) => {
    fragmentCache.delete(key);
    fragmentCache.set(key, html);
    while (fragmentCache.size > MAX_FRAGMENT_CACHE_ENTRIES) fragmentCache.delete(fragmentCache.keys().next().value);
  };
  const initialMain = document.querySelector('main');
  if (initialMain) rememberFragment(fragmentKey(new URL(window.location.href)), initialMain.innerHTML);
  const loadFragment = async (target, key) => {
    const cached = fragmentCache.get(key);
    if (cached !== undefined) return cached;
    const pending = fragmentRequests.get(key);
    if (pending) return pending;
    const request = (async () => {
      const response = await fetch(target.href, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('dashboard navigation failed');
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      const nextMain = page.querySelector('main');
      if (!nextMain) throw new Error('dashboard response has no main element');
      const fragment = nextMain.innerHTML;
      rememberFragment(key, fragment);
      return fragment;
    })();
    fragmentRequests.set(key, request);
    try {
      return await request;
    } finally {
      if (fragmentRequests.get(key) === request) fragmentRequests.delete(key);
    }
  };
  const prefetchDashboard = (target) => {
    if (target.origin !== window.location.origin || target.pathname !== '/command-center') return;
    const key = fragmentKey(target);
    if (fragmentCache.has(key) || fragmentRequests.has(key)) return;
    void loadFragment(target, key).catch(() => {});
  };
  const shouldPrefetch = (link) => link.matches('.period-quick-link, .period-menu a, .period-nav');
  document.addEventListener('pointerover', (event) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest('a[href]');
    if (!link || !shouldPrefetch(link) || (event.relatedTarget instanceof Node && link.contains(event.relatedTarget))) return;
    prefetchDashboard(new URL(link.href, window.location.href));
  });
  document.addEventListener('focusin', (event) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest('a[href]');
    if (link && shouldPrefetch(link)) prefetchDashboard(new URL(link.href, window.location.href));
  });
  let navigationSerial = 0;
  const navigateDashboard = async (target, replace = false) => {
    const main = document.querySelector('main');
    if (!main) return;
    const serial = ++navigationSerial;
    const key = fragmentKey(target);
    main.classList.add('dashboard-loading');
    main.setAttribute('aria-busy', 'true');
    try {
      let fragment = fragmentCache.get(key);
      if (fragment === undefined) {
        fragment = await loadFragment(target, key);
      } else {
        rememberFragment(key, fragment);
      }
      if (serial !== navigationSerial) return;
      main.innerHTML = fragment;
      if (replace) history.replaceState({}, '', target.href);
      else history.pushState({}, '', target.href);
      applyTheme(themeModeOf());
      bindDashboardInteractions(main);
      window.scrollTo(0, 0);
    } catch {
      if (serial === navigationSerial) window.location.assign(target.href);
    } finally {
      if (serial === navigationSerial) {
        main.classList.remove('dashboard-loading');
        main.removeAttribute('aria-busy');
      }
    }
  };
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    const link = event.target.closest('a[href]');
    if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
    const target = new URL(link.href, window.location.href);
    if (target.origin !== window.location.origin || target.pathname !== '/command-center') return;
    event.preventDefault();
    void navigateDashboard(target);
  });
  window.addEventListener('popstate', () => void navigateDashboard(new URL(window.location.href), true));
  let dashboardFingerprint = '';
  let fingerprintRequest = null;
  const checkDashboardFingerprint = async () => {
    if (fingerprintRequest) return fingerprintRequest;
    fingerprintRequest = (async () => {
      try {
        const response = await fetch('/api/command-center/fingerprint', { credentials: 'same-origin' });
        if (!response.ok) return;
        const payload = await response.json();
        const fingerprint = JSON.stringify([
          payload.pipelineUpdatedAt,
          payload.latestJobUpdatedAt,
          payload.latestEventAt,
          payload.videoRevision,
          payload.analyticsRevision,
          payload.studioRevision,
        ]);
        const editingForm = document.activeElement instanceof Element && document.activeElement.closest('form');
        if (editingForm) return;
        if (dashboardFingerprint && fingerprint !== dashboardFingerprint) {
          fragmentCache.clear();
          void navigateDashboard(new URL(window.location.href), true);
        }
        dashboardFingerprint = fingerprint;
      } catch { /* the current screen remains usable while the worker restarts */ }
    })().finally(() => {
      fingerprintRequest = null;
    });
    return fingerprintRequest;
  };
  void checkDashboardFingerprint();
  window.setInterval(() => void checkDashboardFingerprint(), 60000);
`;
