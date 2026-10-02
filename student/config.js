/**
 * Runtime configuration for the student SPA.
 *
 * The Supabase URL and publishable key are PUBLIC by design — the publishable
 * key only ever reaches RLS-guarded RPCs, and every student action goes through
 * a SECURITY DEFINER function (Section B of the schema grants students zero
 * table privileges). There is therefore no secret in this file.
 *
 * Local development override, mirroring the v1 `?api=` convention:
 *   index.html?sb=http://127.0.0.1:54321&sbkey=<publishable-key>
 * or persist it once:
 *   localStorage.setItem('adqs_sb_url', 'http://127.0.0.1:54321')
 *   localStorage.setItem('adqs_sb_key', '<publishable-key>')
 */
(function () {
  var params = new URLSearchParams(window.location.search);

  function pick(paramName, storageKey) {
    return params.get(paramName) || localStorage.getItem(storageKey) || '';
  }

  window.APP_CONFIG = {
    supabaseUrl: pick('sb', 'adqs_sb_url') || 'https://gmjzhgultqqvsfrdeymj.supabase.co',
    supabaseKey: pick('sbkey', 'adqs_sb_key') || 'sb_publishable_imRPFwvw3Ynz6wVEpZ9TNA_v1S6ym0W',
  };
})();
