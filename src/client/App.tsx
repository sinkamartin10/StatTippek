import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Landing from './pages/Landing';
import Matches from './pages/Matches';
import Analysis from './pages/Analysis';
import Tips from './pages/Tips';
import Slips from './pages/Slips';
import Pro from './pages/Pro';
import Profile from './pages/Profile';
import Competitions from './pages/Competitions';
import CompetitionDetail from './pages/CompetitionDetail';
import AdminCompetitions from './pages/AdminCompetitions';
import MyStats from './pages/MyStats';
import Battles from './pages/Battles';
import BattleDetail from './pages/BattleDetail';
import Notifications from './pages/Notifications';
import Stats from './pages/Stats';
import History from './pages/History';
import Sources from './pages/Sources';
import Settings from './pages/Settings';
import MatchDetail from './pages/MatchDetail';
import Search from './pages/Search';
import Team from './pages/Team';
import { EmptyState, Loading } from './components/ui';
import { useAuth } from './auth/AuthContext';
import { ForgotPasswordPage, LoginPage, NewPasswordPage, RegisterPage, RequireAuth } from './auth/AuthPages';

/** Kezdőoldal: látogatónak nyitóoldal, bejelentkezett felhasználónak (vagy Supabase nélküli helyi módban) a dashboard. */
function HomeGate() {
  const auth = useAuth();
  if (!auth.configured) return <Navigate to="/dashboard" replace />;
  if (auth.loading) return <Loading text="Betöltés…" />;
  return auth.user ? <Navigate to="/dashboard" replace /> : <Landing />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomeGate />} />
      <Route element={<Layout />}>
        <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
        <Route path="/bejelentkezes" element={<LoginPage />} />
        <Route path="/regisztracio" element={<RegisterPage />} />
        <Route path="/elfelejtett-jelszo" element={<ForgotPasswordPage />} />
        <Route path="/uj-jelszo" element={<NewPasswordPage />} />
        <Route path="/meccsek" element={<Matches />} />
        <Route path="/elemzes" element={<Analysis />} />
        <Route path="/tippek" element={<Tips />} />
        <Route path="/szelvenyek" element={<Slips />} />
        <Route path="/pro" element={<Pro />} />
        <Route path="/profil" element={<Profile />} />
        <Route path="/statisztikaim" element={<RequireAuth><MyStats /></RequireAuth>} />
        <Route path="/ertesitesek" element={<RequireAuth><Notifications /></RequireAuth>} />
        <Route path="/battles" element={<RequireAuth><Battles /></RequireAuth>} />
        <Route path="/battles/:id" element={<RequireAuth><BattleDetail /></RequireAuth>} />
        <Route path="/tippverseny" element={<Competitions />} />
        <Route path="/tippverseny/:id" element={<CompetitionDetail />} />
        {/* A felületi védelem csak kényelmi – a jogosultságot a szerver ellenőrzi (ADMIN_EMAILS) */}
        <Route path="/admin/tippverseny" element={<RequireAuth><AdminCompetitions /></RequireAuth>} />
        <Route path="/statisztikak" element={<Stats />} />
        <Route path="/elozmenyek" element={<History />} />
        <Route path="/forrasok" element={<Sources />} />
        <Route path="/beallitasok" element={<Settings />} />
        <Route path="/meccs/:id" element={<MatchDetail />} />
        <Route path="/csapat/:id" element={<Team />} />
        <Route path="/kereses" element={<Search />} />
        <Route path="*" element={<EmptyState emoji="🧭" title="Az oldal nem található" text="Ellenőrizd a címet, vagy válassz a menüből." />} />
      </Route>
    </Routes>
  );
}
