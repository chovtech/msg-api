/**
 * Wamator Auth Utilities
 * Session management, vendor/app_user caching, and auth guards.
 */
const WamatorAuth = (() => {
  const VENDOR_KEY = 'wamator_vendor';
  const APP_USER_KEY = 'wamator_app_user';

  /** Get cached vendor from sessionStorage */
  function getVendor() {
    try {
      const raw = sessionStorage.getItem(VENDOR_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  /** Save vendor to sessionStorage */
  function setVendor(vendor) {
    sessionStorage.setItem(VENDOR_KEY, JSON.stringify(vendor));
  }

  /** Get cached app_user from sessionStorage */
  function getAppUser() {
    try {
      const raw = sessionStorage.getItem(APP_USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  /** Save app_user to sessionStorage */
  function setAppUser(user) {
    sessionStorage.setItem(APP_USER_KEY, JSON.stringify(user));
  }

  /**
   * Ensure a default app_user exists for this vendor.
   * The backend requires an app_user_id for contacts/numbers/connect APIs.
   * If the vendor has no app_users yet, we create one automatically.
   */
  async function ensureDefaultAppUser(vendor) {
    // Check cache first
    const cached = getAppUser();
    if (cached) return cached;

    try {
      const res = await WamatorAPI.get('/users/list');
      const users = res.users || [];

      if (users.length > 0) {
        setAppUser(users[0]);
        return users[0];
      }

      // No app_user exists — create a default one from vendor info
      const createRes = await WamatorAPI.post('/users/register', {
        name: vendor.name,
        email: vendor.email,
        company_name: vendor.company_name || vendor.name,
      });

      const newUser = {
        id: createRes.id,
        name: vendor.name,
        email: vendor.email,
        company_name: vendor.company_name || vendor.name,
      };
      setAppUser(newUser);
      return newUser;
    } catch (err) {
      console.error('ensureDefaultAppUser failed:', err);
      return null;
    }
  }

  /**
   * Require authentication. Calls GET /session/me to validate cookie.
   * Returns { vendor, appUser } or redirects to login.
   */
  async function requireAuth() {
    try {
      const data = await WamatorAPI.get('/session/me');
      const vendor = data.vendor;
      setVendor(vendor);

      const appUser = await ensureDefaultAppUser(vendor);

      return { vendor, appUser };
    } catch (err) {
      sessionStorage.removeItem(VENDOR_KEY);
      sessionStorage.removeItem(APP_USER_KEY);
      window.location.href = '/auth/login.html';
      return null;
    }
  }

  /** Redirect away from auth pages if already logged in */
  async function redirectIfAuthenticated(to) {
    try {
      const data = await WamatorAPI.get('/session/me');
      if (data && data.vendor) {
        setVendor(data.vendor);
        window.location.href = to || '/dashboard/';
      }
    } catch {
      // Not authenticated — stay on current page
    }
  }

  /** Log out — clear cookie + sessionStorage, redirect to login */
  async function logout() {
    try {
      await WamatorAPI.post('/session/logout');
    } catch { /* ignore */ }
    sessionStorage.removeItem(VENDOR_KEY);
    sessionStorage.removeItem(APP_USER_KEY);
    window.location.href = '/auth/login.html';
  }

  return {
    getVendor,
    setVendor,
    getAppUser,
    setAppUser,
    ensureDefaultAppUser,
    requireAuth,
    redirectIfAuthenticated,
    logout,
  };
})();
