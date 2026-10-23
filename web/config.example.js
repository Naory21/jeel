// Copy to web/config.js (git-ignored) to run the page against a Supabase project.
// The GitHub Pages workflow writes this file from the repository variables
// SUPABASE_URL and SUPABASE_ANON_KEY. Both values are public by design: the anon key
// can only do what the database's row-level security allows.
// Leave it out (or empty) to run against the local server: node server.js
window.JEEL_CONFIG = {
  supabaseUrl: 'https://YOUR-PROJECT-REF.supabase.co',
  supabaseAnonKey: 'YOUR-ANON-OR-PUBLISHABLE-KEY'
};
