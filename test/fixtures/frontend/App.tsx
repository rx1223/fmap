import { Routes, Route } from "react-router-dom";
import { FinancePage } from "./pages/FinancePage";
import { UserAdminPage } from "./pages/UserAdminPage";
import { CardPage } from "./pages/CardPage";

// React Router tree → sitemap pages + parent edges. UserDetailPage has no
// GraphQL calls of its own; it shows up as a route-only page + a User hub.
export function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />}>
        <Route path="finance" element={<FinancePage />} />
        <Route path="users" element={<UserAdminPage />} />
        <Route path="users/:userId" element={<UserDetailPage />} />
        <Route path="cards" element={<CardPage />} />
      </Route>
    </Routes>
  );
}
