import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in environment variables.");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type AttendancePayload = {
  employee_id: string;
  type: "in" | "out";
  timestamp: string;
  late: boolean;
};

export type BreakPayload = {
  employee_id: string;
  type: "start" | "end";
  reason: string;
  planned_duration_minutes: number | null;
  timestamp: string;
};

export type InactivityPayload = {
  employee_id: string;
  start_time: string;
  end_time: string;
  duration_seconds: number;
  classification: "business" | "personal" | "unclassified";
  justification?: string | null;
};

export type EmployeeProfile = {
  id?: string;
  employee_id: string;
  name: string;
  email?: string;
  role: string;
  department: string;
  avatar_url?: string;
};
