// Konfigurasi koneksi Supabase — dipakai bersama oleh login.js dan script.js.
// SUPABASE_ANON_KEY aman ditaruh di sini (di frontend/browser), karena akses
// data sebenarnya dikontrol oleh Row Level Security (RLS) di sisi Supabase,
// bukan oleh kerahasiaan key ini.

const SUPABASE_URL = 'https://ziihemmeuenctpiutkqc.supabase.co/rest/v1/';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InppaWhlbW1ldWVuY3RwaXV0a3FjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg3ODg2MDUsImV4cCI6MjEwNDM2NDYwNX0.T8qC_Z1olTrdoSDxON7g6XgL3qnzXRGYahdJ5x-_NTA';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
