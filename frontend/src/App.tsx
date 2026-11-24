import { ReactNode } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import Login from "./pages/Login";
import Register from "./pages/Register";
import Dashboard from "./pages/Dashboard";
import Customers from "./pages/Customers";
import CustomerDetail from "./pages/CustomerDetail";
import Challans from "./pages/Challans";
import ChallanCreate from "./pages/ChallanCreate";
import ChallanDetail from "./pages/ChallanDetail";
import Warehouse from "./pages/Warehouse";
import Accounts from "./pages/Accounts";
import UserManagement from "./pages/UserManagement";
import AuditLogs from "./pages/AuditLogs";
import Monitoring from "./pages/Monitoring";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import VerifyEmail from "./pages/VerifyEmail";
import LoginPasskey from "./pages/LoginPasskey";
import MfaRecovery from "./pages/MfaRecovery";
import Profile from "./pages/Profile";
import Layout from "./components/Layout";
import ProtectedRoute from "./components/ProtectedRoute";
import AdminRoute from "./components/AdminRoute";

function Protected({ children }: { children: ReactNode }) {
  return (
    <ProtectedRoute>
      <Layout>{children}</Layout>
    </ProtectedRoute>
  );
}

function Admin({ children }: { children: ReactNode }) {
  return (
    <AdminRoute>
      <Layout>{children}</Layout>
    </AdminRoute>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/login-passkey" element={<LoginPasskey />} />
      <Route path="/mfa-recovery" element={<MfaRecovery />} />
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="/dashboard" element={<Protected><Dashboard /></Protected>} />
      <Route path="/customers" element={<Protected><Customers /></Protected>} />
      <Route path="/customers/:id" element={<Protected><CustomerDetail /></Protected>} />
      <Route path="/challans" element={<Protected><Challans /></Protected>} />
      <Route path="/challans/new" element={<Protected><ChallanCreate /></Protected>} />
      <Route path="/challans/:id" element={<Protected><ChallanDetail /></Protected>} />
      <Route path="/warehouse" element={<Protected><Warehouse /></Protected>} />
      <Route path="/accounts" element={<Protected><Accounts /></Protected>} />
      <Route path="/users" element={<Admin><UserManagement /></Admin>} />
      <Route path="/audit-logs" element={<Admin><AuditLogs /></Admin>} />
      <Route path="/monitoring" element={<Admin><Monitoring /></Admin>} />
      <Route path="/profile" element={<Protected><Profile /></Protected>} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
