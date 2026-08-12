import { useEffect, useMemo, useState } from "react";
import { supabase, EmployeeProfile } from "./lib/supabase";
import { useActivityDetector } from "./hooks/useActivityDetector";
import logoImg from "./assets/logo.png";

const EMPLOYEE_ID_KEY = "attendance_employee_id";
const LAST_CLOCK_IN_KEY = "attendance_last_clock_in";
const ACTIVE_BREAK_KEY = "attendance_active_break";
const SHIFT_HOURS_KEY = "attendance_shift_hours";
const SHIFT_START_KEY = "attendance_shift_start";

const TOTAL_BREAK_MS = 60 * 60 * 1000; // 1 hour (60 minutes)
const IDLE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes inactivity

export function getKarachiDateParts(date: Date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const getVal = (type: string) => parts.find(p => p.type === type)?.value || "0";
  return {
    year: getVal("year"),
    month: getVal("month"),
    day: getVal("day"),
    hour: parseInt(getVal("hour"), 10),
    minute: parseInt(getVal("minute"), 10),
    second: parseInt(getVal("second"), 10),
  };
}

export function getKarachiTodayStr(): string {
  const { year, month, day } = getKarachiDateParts(new Date());
  return `${year}-${month}-${day}`;
}

export const SHIFT_OPTIONS = [
  { id: "shift-1", label: "11:00 AM to 8:00 PM", start: "11:00", hours: 9 },
  { id: "shift-2", label: "4:00 PM to 1:00 AM", start: "16:00", hours: 9 },
  { id: "shift-3", label: "6:00 PM to 3:00 AM", start: "18:00", hours: 9 },
  { id: "shift-4", label: "8:00 PM to 5:00 AM", start: "20:00", hours: 9 },
];

type LogItem = {
  id: string;
  type: "in" | "out" | "break_start" | "break_end" | "away";
  label: string;
  timestamp: string;
  detail?: string;
  isRed?: boolean;
};

function getInitials(name: string): string {
  if (!name) return "QA";
  const parts = name.trim().split(" ");
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function App() {
  const [employeeId, setEmployeeId] = useState<string>(() => localStorage.getItem(EMPLOYEE_ID_KEY) ?? "");
  const [clockInAt, setClockInAt] = useState<string | null>(() => localStorage.getItem(LAST_CLOCK_IN_KEY));
  const [activeBreak, setActiveBreak] = useState<{
    reason: string;
    duration: number | null;
    startTime: string;
  } | null>(() => {
    const saved = localStorage.getItem(ACTIVE_BREAK_KEY);
    return saved ? JSON.parse(saved) : null;
  });

  const [now, setNow] = useState(new Date());
  const [submitting, setSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>("Enter Employee ID to begin");
  
  // User Profile States
  const [employeeProfile, setEmployeeProfile] = useState<EmployeeProfile | null>(null);

  // Custom Break Planner States
  const [customBreakDuration, setCustomBreakDuration] = useState<number>(15);
  const [customBreakReasonType, setCustomBreakReasonType] = useState<"smoke" | "tea" | "meeting" | "personal">("tea");
  const [customBreakCustomReason, setCustomBreakCustomReason] = useState<string>("");
  const [showCustomBreakForm, setShowCustomBreakForm] = useState<boolean>(false);

  // Device Setup / Onboarding States
  const [setupEmployeeId, setSetupEmployeeId] = useState("");
  const [setupShiftOptionId, setSetupShiftOptionId] = useState("shift-1");

  const [shiftOptionId, setShiftOptionId] = useState<string>(() => {
    const start = localStorage.getItem(SHIFT_START_KEY);
    const hours = localStorage.getItem(SHIFT_HOURS_KEY);
    if (start && hours) {
      const match = SHIFT_OPTIONS.find((s) => s.start === start && s.hours === parseInt(hours, 10));
      if (match) return match.id;
    }
    return "shift-1";
  });

  const currentShift = useMemo(() => {
    return SHIFT_OPTIONS.find((s) => s.id === shiftOptionId) || SHIFT_OPTIONS[0];
  }, [shiftOptionId]);

  const shiftHours = currentShift.hours;
  const shiftStart = currentShift.start;

  // Shift Settings Modal States
  const [isShiftModalOpen, setIsShiftModalOpen] = useState(false);
  const [tempShiftOptionId, setTempShiftOptionId] = useState(shiftOptionId);

  // Calendar Exploration States
  const [selectedDateStr, setSelectedDateStr] = useState<string>(() => {
    return getKarachiTodayStr();
  });

  // Meeting Break Justification States
  const [showMeetingJustifyModal, setShowMeetingJustifyModal] = useState(false);
  const [meetingJustification, setMeetingJustification] = useState("");

  // Inactivity Away Justification State
  const [awayJustification, setAwayJustification] = useState("");


  // Onboarding / Profile Form Fields
  const [onboardName, setOnboardName] = useState("");

  // Return-from-Away Modal State
  const [awayDetails, setAwayDetails] = useState<{
    durationSeconds: number;
    startTime: string;
    endTime: string;
  } | null>(null);

  // Loaded Timeline Logs
  const [todayLogs, setTodayLogs] = useState<LogItem[]>([]);
  // Accumulated break milliseconds from today's completed breaks
  const [accumulatedBreakMs, setAccumulatedBreakMs] = useState(0);

  // Auto-launch on Windows Startup (Tauri Desktop only)
  async function setupAutostart() {
    try {
      if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
        const { enable, isEnabled } = await import("@tauri-apps/plugin-autostart");
        const active = await isEnabled();
        if (!active) {
          await enable();
          console.log("🚀 Autostart enabled successfully for desktop boot!");
        }
      }
    } catch (e) {
      console.error("Autostart setup failed:", e);
    }
  }



  // Fetch employee profile from Supabase
  async function fetchProfile(empId: string) {
    const trimmed = empId.trim();
    if (!trimmed) {
      setEmployeeProfile(null);
      return;
    }

    setSubmitting(true);
    try {
      const { data, error } = await supabase
        .from("employees")
        .select("*")
        .eq("employee_id", trimmed)
        .maybeSingle();

      if (error) {
        setStatusMessage(`Error fetching profile: ${error.message}`);
        setSubmitting(false);
        return;
      }

      if (data) {
        setEmployeeProfile(data as EmployeeProfile);
        setStatusMessage(`Active profile: ${data.name}`);
        loadTodayLogs();
      } else {
        setEmployeeProfile(null);
        setStatusMessage(`Profile not registered for ID: ${trimmed}`);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setSubmitting(false);
    }
  }

  // Complete device setup: pair workstation with name and employee id
  async function handleDeviceSetup() {
    const trimmedId = setupEmployeeId.trim();
    const name = onboardName.trim();

    if (!trimmedId || !name) {
      setStatusMessage("Both Employee ID and Full Name are required.");
      return;
    }

    setSubmitting(true);
    try {
      // Check if ID is already registered in the system
      const { data: existing, error: checkError } = await supabase
        .from("employees")
        .select("*")
        .eq("employee_id", trimmedId)
        .maybeSingle();

      if (checkError) {
        setStatusMessage(`Verification error: ${checkError.message}`);
        setSubmitting(false);
        return;
      }

      const selectedShift = SHIFT_OPTIONS.find(s => s.id === setupShiftOptionId) || SHIFT_OPTIONS[0];

      if (existing) {
        // ID exists! Update their profile name and pair the device
        const { error: updateError } = await supabase
          .from("employees")
          .update({ name })
          .eq("employee_id", trimmedId);

        if (updateError) {
          setStatusMessage(`Sync Failed: ${updateError.message}`);
          setSubmitting(false);
          return;
        }

        // Save custom shift timing settings
        localStorage.setItem(SHIFT_HOURS_KEY, selectedShift.hours.toString());
        localStorage.setItem(SHIFT_START_KEY, selectedShift.start);
        setShiftOptionId(setupShiftOptionId);

        setEmployeeId(trimmedId);
        setEmployeeProfile({ ...existing, name } as unknown as EmployeeProfile);
        setStatusMessage(`Welcome back, ${name}! Device successfully paired.`);
      } else {
        // ID does not exist! Register new profile with default role/department
        const payload = {
          employee_id: trimmedId,
          name,
          role: "Team Member",
          department: "Corporate",
          email: null,
          avatar_url: null,
        };

        const { error: insertError } = await supabase.from("employees").insert(payload);
        if (insertError) {
          setStatusMessage(`Registration Failed: ${insertError.message}`);
          setSubmitting(false);
          return;
        }

        // Save custom shift timing settings
        localStorage.setItem(SHIFT_HOURS_KEY, selectedShift.hours.toString());
        localStorage.setItem(SHIFT_START_KEY, selectedShift.start);
        setShiftOptionId(setupShiftOptionId);

        setEmployeeId(trimmedId);
        setEmployeeProfile(payload as unknown as EmployeeProfile);
        setStatusMessage(`Profile registered! Welcome, ${name}.`);
      }
    } catch (e: any) {
      console.error(e);
      setStatusMessage(`Device Setup failed: ${e.message || e}`);
    } finally {
      setSubmitting(false);
    }
  }

  // Update shift timing dynamically from the dashboard
  async function updateShiftTiming(newOptionId: string) {
    const selectedShift = SHIFT_OPTIONS.find((s) => s.id === newOptionId);
    if (!selectedShift) return;

    setShiftOptionId(newOptionId);
    localStorage.setItem(SHIFT_HOURS_KEY, selectedShift.hours.toString());
    localStorage.setItem(SHIFT_START_KEY, selectedShift.start);
    
    setStatusMessage(`Shift updated to: ${selectedShift.label}`);
    setIsShiftModalOpen(false);
  }



  // Sync employeeId to local storage and fetch profile
  useEffect(() => {
    const trimmed = employeeId.trim();
    localStorage.setItem(EMPLOYEE_ID_KEY, trimmed);
    if (trimmed) {
      fetchProfile(trimmed);
    } else {
      setStatusMessage("Enter Employee ID to begin");
      setEmployeeProfile(null);
      setTodayLogs([]);
      setAccumulatedBreakMs(0);
    }
  }, [employeeId]);

  // Keep digital clock updating & initialize autostart setup on desktop
  useEffect(() => {
    setupAutostart();
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Prevent webview zoom from keyboard shortcuts and mouse wheel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === "+" || e.key === "-" || e.key === "=" || e.key === "0")
      ) {
        e.preventDefault();
      }
    };
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("wheel", handleWheel);
    };
  }, []);

  // Sync selectedDateStr to reload history logs dynamically
  useEffect(() => {
    if (employeeId.trim()) {
      loadTodayLogs();
    }
  }, [selectedDateStr, employeeId]);

  // Check for stale clock-in sessions (>14 hours) and auto-clock out to start fresh
  useEffect(() => {
    if (!clockInAt || !employeeId.trim()) return;

    const checkStaleSession = async () => {
      const inTime = new Date(clockInAt).getTime();
      const elapsedMs = now.getTime() - inTime;
      const FOURTEEN_HOURS_MS = 14 * 60 * 60 * 1000;

      if (elapsedMs > FOURTEEN_HOURS_MS) {
        // Stale clock-in detected! Auto-clock out at expected shift end time
        setSubmitting(true);
        const autoOutTime = new Date(inTime + shiftHours * 60 * 60 * 1000);
        
        // If they had an active break, close it
        if (activeBreak) {
          const breakPayload = {
            employee_id: employeeId.trim(),
            type: "end",
            reason: activeBreak.reason,
            planned_duration_minutes: activeBreak.duration,
            timestamp: autoOutTime.toISOString(),
          };
          await supabase.from("breaks").insert(breakPayload);
        }

        const outPayload = {
          employee_id: employeeId.trim(),
          type: "out",
          timestamp: autoOutTime.toISOString(),
          late: false,
        };

        const { error } = await supabase.from("attendance").insert(outPayload);
        if (!error) {
          localStorage.removeItem(LAST_CLOCK_IN_KEY);
          localStorage.removeItem(ACTIVE_BREAK_KEY);
          setClockInAt(null);
          setActiveBreak(null);
          setStatusMessage("Stale session detected: Auto-clocked out at expected end time.");
          loadTodayLogs();
        } else {
          console.error("Auto clock out failed:", error.message);
        }
        setSubmitting(false);
      }
    };

    checkStaleSession();
  }, [clockInAt, employeeId, shiftHours, now]);

  const isClockedIn = !!clockInAt;
  const isOnBreak = !!activeBreak;

  // Global Inactivity Detector Hook (15 minute threshold)
  const { isIdle } = useActivityDetector({
    employeeId,
    isClockedIn,
    isOnBreak,
    thresholdMs: IDLE_THRESHOLD_MS,
    onAwayDetected: (durationSeconds, startTime, endTime) => {
      // Trigger Return-from-Away popup modal
      setAwayDetails({ durationSeconds, startTime, endTime });
    },
  });

  // Load all events (attendance, breaks, and idle logs) from the selected date's workday (06:00 AM to 06:00 AM next day)
  async function loadTodayLogs(dateOverrideStr?: string) {
    const empId = employeeId.trim();
    if (!empId) return;

    const targetDateStr = dateOverrideStr || selectedDateStr;
    const [year, month, day] = targetDateStr.split("-").map(Number);
    
    // Workday Start: 06:00 AM on the target date in Karachi timezone (UTC+5, so 01:00 AM UTC)
    const workdayStartUtc = new Date(Date.UTC(year, month - 1, day, 1, 0, 0, 0));
    const workdayStartIso = workdayStartUtc.toISOString();

    // Workday End: 06:00 AM on the next day in Karachi timezone (01:00 AM UTC next day)
    const workdayEndUtc = new Date(Date.UTC(year, month - 1, day + 1, 1, 0, 0, 0));
    const workdayEndIso = workdayEndUtc.toISOString();

    try {
      const items: LogItem[] = [];
      let totalManualBreakMs = 0;

      // 1. Fetch attendance logs within the workday window
      const { data: att } = await supabase
        .from("attendance")
        .select("id, type, timestamp, late")
        .eq("employee_id", empId)
        .gte("timestamp", workdayStartIso)
        .lt("timestamp", workdayEndIso)
        .order("timestamp", { ascending: true });

      if (att) {
        att.forEach((a) => {
          items.push({
            id: a.id,
            type: a.type as "in" | "out",
            label: a.type === "in" ? "Clocked In" : "Clocked Out",
            timestamp: a.timestamp,
            detail: a.type === "in" && a.late ? `Late Arrival (after ${shiftStart})` : undefined,
            isRed: a.type === "in" && a.late,
          });
        });
      }

      // 2. Fetch manual breaks within the workday window
      const { data: brk } = await supabase
        .from("breaks")
        .select("id, type, reason, planned_duration_minutes, timestamp")
        .eq("employee_id", empId)
        .gte("timestamp", workdayStartIso)
        .lt("timestamp", workdayEndIso)
        .order("timestamp", { ascending: true });

      if (brk) {
        brk.forEach((b) => {
          let displayReason = b.reason;
          if (b.reason.startsWith("meeting:")) {
            displayReason = "meeting";
          }
          items.push({
            id: b.id,
            type: b.type === "start" ? "break_start" : "break_end",
            label: b.type === "start" ? `Started Break (${displayReason})` : `Finished Break (${b.reason.replace("meeting:", "Meeting:")})`,
            timestamp: b.timestamp,
            detail: b.planned_duration_minutes ? `Planned: ${b.planned_duration_minutes}m` : undefined,
            isRed: true,
          });
        });

        // Compute manual break durations
        const starts = brk.filter((b) => b.type === "start");
        const ends = brk.filter((b) => b.type === "end");
        
        starts.forEach((s) => {
          const matchingEnd = ends.find((e) => {
            const eReasonBase = e.reason.startsWith("meeting") ? "meeting" : e.reason;
            const sReasonBase = s.reason.startsWith("meeting") ? "meeting" : s.reason;
            return eReasonBase === sReasonBase && new Date(e.timestamp) > new Date(s.timestamp);
          });
          if (matchingEnd) {
            const elapsed = new Date(matchingEnd.timestamp).getTime() - new Date(s.timestamp).getTime();
            totalManualBreakMs += elapsed;
          }
        });
      }

      // 3. Fetch inactivity logs within the workday window
      const { data: idle } = await supabase
        .from("inactivity_logs")
        .select("id, start_time, end_time, duration_seconds, classification, justification")
        .eq("employee_id", empId)
        .gte("start_time", workdayStartIso)
        .lt("start_time", workdayEndIso)
        .order("start_time", { ascending: true });

      if (idle) {
        idle.forEach((i: any) => {
          const durMins = Math.round(i.duration_seconds / 60);
          const justificationStr = i.justification ? ` - ${i.justification}` : "";
          items.push({
            id: i.id,
            type: "away",
            label: `Away (${i.classification}${justificationStr})`,
            timestamp: i.start_time,
            detail: `Duration: ${durMins} mins`,
            isRed: i.classification === "personal",
          });

          if (i.classification === "personal") {
            totalManualBreakMs += i.duration_seconds * 1000;
          }
        });
      }

      // Sort timeline items chronologically
      items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      
      setTodayLogs(items);
      setAccumulatedBreakMs(totalManualBreakMs);
    } catch (e) {
      console.error("Error loading history logs:", e);
    }
  }

  // Calculate dynamic shift milliseconds
  const shiftMs = useMemo(() => shiftHours * 60 * 60 * 1000, [shiftHours]);

  // Calculate hands angles for the analog clock in Karachi local time
  const clockAngles = useMemo(() => {
    const parts = getKarachiDateParts(now);
    const hours = parts.hour;
    const minutes = parts.minute;
    const seconds = parts.second;

    const secondAngle = seconds * 6;
    const minuteAngle = minutes * 6 + seconds * 0.1;
    const hourAngle = (hours % 12) * 30 + minutes * 0.5;

    return { hourAngle, minuteAngle, secondAngle };
  }, [now]);

  // Calculate live dynamic colors based on state
  // Green if active and working, Red if on break, late, or away
  const themeColors = useMemo(() => {
    const [startHour, startMin] = shiftStart.split(":").map(Number);
    let isLate = false;
    if (clockInAt) {
      const clockInDate = new Date(clockInAt);
      const karachiTimeStr = clockInDate.toLocaleTimeString("en-US", {
        timeZone: "Asia/Karachi",
        hour12: false,
      });
      const [inHour, inMin] = karachiTimeStr.split(":").map(Number);
      isLate = inHour > startHour || (inHour === startHour && inMin > startMin);
    }
    const isRed = isOnBreak || isIdle || (isClockedIn && isLate);

    if (isRed) {
      return {
        accent: "var(--red)",
        accentSoft: "var(--red-soft)",
        accentGlow: "var(--red-glow)",
      };
    } else {
      return {
        accent: "var(--green)",
        accentSoft: "var(--green-soft)",
        accentGlow: "var(--green-glow)",
      };
    }
  }, [clockInAt, isOnBreak, isIdle, isClockedIn, shiftStart]);

  // Compute shift timings
  const shiftMetrics = useMemo(() => {
    if (!clockInAt) {
      return {
        progressPercent: 0,
        remainingMs: shiftMs,
        workedMs: 0,
        totalBreakMs: 0,
      };
    }

    const inTime = new Date(clockInAt).getTime();
    const totalElapsed = Math.max(0, now.getTime() - inTime);
    
    // Total work done (subtract active manual break time and accumulated break time)
    const activeBreakElapsed = activeBreak ? now.getTime() - new Date(activeBreak.startTime).getTime() : 0;
    const totalBreakElapsed = accumulatedBreakMs + activeBreakElapsed;

    const actualWorked = Math.max(0, totalElapsed - totalBreakElapsed);
    const clampedWorked = Math.min(shiftMs, actualWorked);
    const remaining = Math.max(0, shiftMs - actualWorked);

    return {
      progressPercent: Math.round((clampedWorked / shiftMs) * 100),
      remainingMs: remaining,
      workedMs: clampedWorked,
      totalBreakMs: totalBreakElapsed,
    };
  }, [clockInAt, now, activeBreak, accumulatedBreakMs, shiftMs]);

  // Compute break allowance timing
  const breakAllowanceMinutesRemaining = useMemo(() => {
    const activeBreakElapsed = activeBreak ? now.getTime() - new Date(activeBreak.startTime).getTime() : 0;
    const totalBreakElapsed = accumulatedBreakMs + activeBreakElapsed;
    const remainingMs = Math.max(0, TOTAL_BREAK_MS - totalBreakElapsed);
    return Math.floor(remainingMs / 60000);
  }, [accumulatedBreakMs, activeBreak, now]);

  // Compute break lockout countdown metrics
  const breakLockoutStatus = useMemo(() => {
    if (!activeBreak || !activeBreak.duration) {
      return { isLocked: false, remainingStr: "" };
    }

    const start = new Date(activeBreak.startTime).getTime();
    const durationMs = activeBreak.duration * 60 * 1000;
    const end = start + durationMs;
    const remainingMs = end - now.getTime();

    if (remainingMs <= 0) {
      return { isLocked: false, remainingStr: "" };
    }

    const mins = Math.floor(remainingMs / 60000);
    const secs = Math.floor((remainingMs % 60000) / 1000);
    const remainingStr = `${mins}m ${secs.toString().padStart(2, "0")}s`;

    return {
      isLocked: true,
      remainingStr
    };
  }, [activeBreak, now]);

  // Compute workday metrics and status summaries for the calendar selected day
  const calendarSummary = useMemo(() => {
    const isTargetToday = selectedDateStr === getKarachiTodayStr();
    const breakDurationMs = accumulatedBreakMs;
    
    let workedDurationMs = 0;
    let isLate = false;
    let hasClockedIn = false;

    // Filter todayLogs for clock events
    const inLogs = todayLogs.filter(item => item.type === "in");
    const outLogs = todayLogs.filter(item => item.type === "out");

    if (inLogs.length > 0) {
      hasClockedIn = true;
      isLate = inLogs.some(log => log.isRed);

      // Sum all clocked-in intervals
      inLogs.forEach(inLog => {
        const inTime = new Date(inLog.timestamp).getTime();
        // Find matching clock-out after this clock-in
        const matchingOut = outLogs.find(outLog => new Date(outLog.timestamp).getTime() > inTime);
        
        if (matchingOut) {
          workedDurationMs += (new Date(matchingOut.timestamp).getTime() - inTime);
        } else if (isTargetToday && clockInAt) {
          workedDurationMs += (now.getTime() - inTime);
        }
      });
      
      workedDurationMs = Math.max(0, workedDurationMs - breakDurationMs);
    }

    return {
      hasClockedIn,
      workedMs: workedDurationMs,
      breakMs: breakDurationMs,
      isLate,
      statusLabel: !hasClockedIn ? "Absent" : isLate ? "Late Arrival" : "Punctual"
    };
  }, [todayLogs, selectedDateStr, clockInAt, now, accumulatedBreakMs]);

  // Attendance Clock In / Out Actions
  async function sendClock(type: "in" | "out") {
    const empId = employeeId.trim();
    if (!empId) {
      setStatusMessage("Enter Employee ID to proceed.");
      return;
    }

    setSubmitting(true);
    const current = new Date();

    if (type === "in") {
      const [startHour, startMin] = shiftStart.split(":").map(Number);
      const karachiTimeStr = current.toLocaleTimeString("en-US", {
        timeZone: "Asia/Karachi",
        hour12: false,
      });
      const [currentHour, currentMin] = karachiTimeStr.split(":").map(Number);
      const isLate = currentHour > startHour || (currentHour === startHour && currentMin > startMin);

      const payload = {
        employee_id: empId,
        type: "in",
        timestamp: current.toISOString(),
        late: isLate,
      };

      const { error } = await supabase.from("attendance").insert(payload);
      if (error) {
        setStatusMessage(`Clock In Failed: ${error.message}`);
        setSubmitting(false);
        return;
      }

      localStorage.setItem(LAST_CLOCK_IN_KEY, payload.timestamp);
      setClockInAt(payload.timestamp);
      setStatusMessage(isLate ? "Clocked In. Marked as Late." : "Clocked In successfully.");
    } else {
      // If user is on an active break, auto-end it first
      if (activeBreak) {
        await toggleBreak(activeBreak.reason, activeBreak.duration);
      }

      const payload = {
        employee_id: empId,
        type: "out",
        timestamp: current.toISOString(),
        late: false,
      };

      const { error } = await supabase.from("attendance").insert(payload);
      if (error) {
        setStatusMessage(`Clock Out Failed: ${error.message}`);
        setSubmitting(false);
        return;
      }

      localStorage.removeItem(LAST_CLOCK_IN_KEY);
      localStorage.removeItem(ACTIVE_BREAK_KEY);
      setClockInAt(null);
      setActiveBreak(null);
      setStatusMessage("Clocked Out successfully.");
    }

    setSubmitting(false);
    loadTodayLogs();
  }

  // Break Controls Action
  async function toggleBreak(
    reason: string,
    duration: number | null = null
  ) {
    const empId = employeeId.trim();
    if (!empId || !isClockedIn) return;

    if (!activeBreak) {
      // Start Break
      setSubmitting(true);
      const current = new Date();
      const payload = {
        employee_id: empId,
        type: "start",
        reason,
        planned_duration_minutes: duration,
        timestamp: current.toISOString(),
      };

      const { error } = await supabase.from("breaks").insert(payload);
      if (error) {
        setStatusMessage(`Failed to start break: ${error.message}`);
        setSubmitting(false);
        return;
      }

      const newBreak = { reason, duration, startTime: payload.timestamp };
      localStorage.setItem(ACTIVE_BREAK_KEY, JSON.stringify(newBreak));
      setActiveBreak(newBreak);
      setStatusMessage(`Break started: ${reason}.`);
      setSubmitting(false);
      loadTodayLogs();
    } else {
      // Ending an active Break
      if (activeBreak.reason.startsWith("meeting")) {
        // Open the justification modal instead of ending immediately!
        setMeetingJustification("");
        setShowMeetingJustifyModal(true);
        return;
      }

      // End active Tea/Lunch Break
      setSubmitting(true);
      const current = new Date();
      const payload = {
        employee_id: empId,
        type: "end",
        reason: activeBreak.reason,
        planned_duration_minutes: activeBreak.duration,
        timestamp: current.toISOString(),
      };

      const { error } = await supabase.from("breaks").insert(payload);
      if (error) {
        setStatusMessage(`Failed to end break: ${error.message}`);
        setSubmitting(false);
        return;
      }

      localStorage.removeItem(ACTIVE_BREAK_KEY);
      setActiveBreak(null);
      setStatusMessage("Break finished. Active shift resumed.");
      setSubmitting(false);
      loadTodayLogs();
    }
  }

  // Handle meeting break return justification submission
  async function submitMeetingJustification() {
    const empId = employeeId.trim();
    if (!empId || !activeBreak) return;

    const trimmedJustification = meetingJustification.trim();
    if (!trimmedJustification) {
      setStatusMessage("Please enter a meeting justification reason.");
      return;
    }

    setSubmitting(true);
    const current = new Date();
    const payload = {
      employee_id: empId,
      type: "end",
      reason: `meeting: ${trimmedJustification}`,
      planned_duration_minutes: activeBreak.duration,
      timestamp: current.toISOString(),
    };

    const { error } = await supabase.from("breaks").insert(payload);
    if (error) {
      setStatusMessage(`Failed to end meeting break: ${error.message}`);
    } else {
      localStorage.removeItem(ACTIVE_BREAK_KEY);
      setActiveBreak(null);
      setShowMeetingJustifyModal(false);
      setMeetingJustification("");
      setStatusMessage("Meeting justification recorded. Active shift resumed.");
      loadTodayLogs();
    }
    setSubmitting(false);
  }

  // Handle return from inactivity away log submission
  async function submitInactivityLog(classification: "business" | "personal") {
    if (!awayDetails || !employeeId.trim()) return;

    const trimmedJustify = awayJustification.trim();
    if (!trimmedJustify) {
      setStatusMessage("Please enter a reason or summary for being away.");
      return;
    }

    setSubmitting(true);
    const payload = {
      employee_id: employeeId.trim(),
      start_time: awayDetails.startTime,
      end_time: awayDetails.endTime,
      duration_seconds: awayDetails.durationSeconds,
      classification,
      justification: trimmedJustify,
    };

    const { error } = await supabase.from("inactivity_logs").insert(payload);
    if (error) {
      setStatusMessage(`Failed to log inactivity: ${error.message}`);
    } else {
      setStatusMessage(`Logged ${Math.round(awayDetails.durationSeconds / 60)}m away as ${classification}.`);
    }

    // Dismiss modal and reload timeline/break calculations
    setAwayDetails(null);
    setAwayJustification("");
    setSubmitting(false);
    loadTodayLogs();
  }

  // Format Helper functions
  function formatTime(date: Date): string {
    return date.toLocaleTimeString("en-GB", {
      timeZone: "Asia/Karachi",
      hour12: false,
    });
  }

  function formatDuration(ms: number): string {
    const totalSecs = Math.max(0, Math.floor(ms / 1000));
    const hrs = Math.floor(totalSecs / 3600).toString().padStart(2, "0");
    const mins = Math.floor((totalSecs % 3600) / 60).toString().padStart(2, "0");
    const secs = (totalSecs % 60).toString().padStart(2, "0");
    return `${hrs}:${mins}:${secs}`;
  }

  return (
    <main className="app-shell">
      <div 
        className={`panel ${!employeeProfile ? "setup-mode" : "dashboard-mode"}`}
        style={{
          "--accent": themeColors.accent,
          "--accent-soft": themeColors.accentSoft,
          "--accent-glow": themeColors.accentGlow,
        } as React.CSSProperties}
      >
        {!employeeProfile ? (
          /* Centered setup view */
          <div className="setup-container">
            <div className="brand-header" style={{ marginBottom: "12px", justifyContent: "center" }}>
              <div className="brand-icon-wrapper">
                <img src={logoImg} alt="Quantum Arc Logo" className="brand-icon-logo-img" />
              </div>
              <div style={{ textAlign: "left" }}>
                <p className="eyebrow" style={{ margin: 0 }}>Quantum Arc</p>
                <h1 style={{ fontSize: "1.6rem" }}>Q Tracker</h1>
              </div>
            </div>

            <div className="setup-card">
              <p className="setup-desc" style={{ fontWeight: 500, fontSize: "14px", color: "var(--muted)", textAlign: "center", marginBottom: "24px" }}>
                Pair this workstation by entering your profile details.
              </p>
              <div className="setup-form">
                <div>
                  <label htmlFor="setupEmpId" className="field-label">Employee ID</label>
                  <input 
                    id="setupEmpId"
                    className="field"
                    placeholder="e.g. EMP-1001"
                    value={setupEmployeeId}
                    onChange={(e) => setSetupEmployeeId(e.target.value)}
                    disabled={submitting}
                  />
                </div>
                <div>
                  <label htmlFor="setupName" className="field-label">Full Name</label>
                  <input 
                    id="setupName"
                    className="field"
                    placeholder="e.g. Jane Doe"
                    value={onboardName}
                    onChange={(e) => setOnboardName(e.target.value)}
                    disabled={submitting}
                  />
                </div>
                <div>
                  <label htmlFor="setupShiftOption" className="field-label">Select Office Shift Timing</label>
                  <select
                    id="setupShiftOption"
                    className="field"
                    value={setupShiftOptionId}
                    onChange={(e) => setSetupShiftOptionId(e.target.value)}
                    disabled={submitting}
                  >
                    {SHIFT_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <button 
                  className="btn btn-clockin" 
                  style={{ marginTop: "8px", padding: "16px" }}
                  onClick={handleDeviceSetup}
                  disabled={submitting}
                >
                  {submitting ? "Pairing Workstation..." : "Link Device & Begin"}
                </button>
              </div>
            </div>

            <div className="status-bar" style={{ marginTop: "24px", width: "100%" }}>{statusMessage}</div>
          </div>
        ) : (
          <>
            {/* Left Column - Shift controls, clock, break widget */}
            <div className="left-col">
              <div className="brand-header">
                <div className="brand-icon-wrapper">
                  <img src={logoImg} alt="Quantum Arc Logo" className="brand-icon-logo-img" />
                </div>
                <div>
                  <p className="eyebrow" style={{ margin: 0 }}>Quantum Arc</p>
                  <h1>Q Tracker</h1>
                </div>
              </div>

              {/* Glowing Digital & Analog Clock */}
              <div className="clock-card">
                <div className="clock-label-row">
                  <p className="clock-label">Pakistan Standard Time (PKT)</p>
                  {isClockedIn && <div className="clock-status-dot" />}
                </div>
                <div className="clock-display-wrapper">
                  <div className="analog-clock-container">
                    <svg className="analog-clock" viewBox="0 0 100 100">
                      <circle cx="50" cy="50" r="48" className="clock-face" />
                      
                      {[...Array(12)].map((_, i) => {
                        const angle = (i * 30 * Math.PI) / 180;
                        const x1 = 50 + 38 * Math.sin(angle);
                        const y1 = 50 - 38 * Math.cos(angle);
                        const x2 = 50 + 44 * Math.sin(angle);
                        const y2 = 50 - 44 * Math.cos(angle);
                        return (
                          <line
                            key={i}
                            x1={x1}
                            y1={y1}
                            x2={x2}
                            y2={y2}
                            className={i % 3 === 0 ? "clock-tick major" : "clock-tick minor"}
                          />
                        );
                      })}
                      
                      <line
                        x1="50"
                        y1="50"
                        x2="50"
                        y2="28"
                        className="clock-hand hour-hand"
                        transform={`rotate(${clockAngles.hourAngle}, 50, 50)`}
                      />
                      <line
                        x1="50"
                        y1="50"
                        x2="50"
                        y2="18"
                        className="clock-hand minute-hand"
                        transform={`rotate(${clockAngles.minuteAngle}, 50, 50)`}
                      />
                      <line
                        x1="50"
                        y1="50"
                        x2="50"
                        y2="12"
                        className="clock-hand second-hand"
                        transform={`rotate(${clockAngles.secondAngle}, 50, 50)`}
                      />
                      <circle cx="50" cy="50" r="2.5" className="clock-center-pin" />
                    </svg>
                  </div>
                  <p className="digital-clock">{formatTime(now)}</p>
                </div>
              </div>

              {/* Premium Glassmorphic Onboarded Profile Card */}
              <div className="break-widget profile-card-container">
                <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
                  <div 
                    style={{
                      width: "52px",
                      height: "52px",
                      borderRadius: "50%",
                      background: "linear-gradient(135deg, var(--accent), var(--accent-soft))",
                      boxShadow: "0 0 15px var(--accent-soft)",
                      display: "grid",
                      placeItems: "center",
                      fontWeight: 700,
                      fontFamily: "var(--font-heading)",
                      fontSize: "16px",
                      color: "#fff"
                    }}
                  >
                    {getInitials(employeeProfile.name)}
                  </div>
                  <div style={{ flexGrow: 1, minWidth: 0 }}>
                    <h3 className="profile-card-name" style={{ margin: 0, fontFamily: "var(--font-heading)", fontSize: "16px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {employeeProfile.name}
                    </h3>
                    <p className="profile-card-role" style={{ margin: "2px 0 0", fontSize: "11px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      {employeeProfile.role}
                    </p>
                    <div style={{ display: "flex", gap: "6px", marginTop: "4px" }}>
                      <span className="badge profile-meta-badge" style={{ fontSize: "8px", padding: "2px 6px" }}>
                        {employeeProfile.department}
                      </span>
                      <span className="badge profile-id-badge" style={{ fontSize: "8px", padding: "2px 6px" }}>
                        {employeeProfile.employee_id}
                      </span>
                    </div>
                  </div>

                </div>
              </div>

              {/* Clock In / Out Buttons */}
              <div className="actions-grid">
                <button
                  className="btn btn-clockin"
                  disabled={isClockedIn || submitting}
                  onClick={() => sendClock("in")}
                >
                  Clock In
                </button>
                <button
                  className="btn btn-clockout"
                  disabled={!isClockedIn || submitting}
                  onClick={() => sendClock("out")}
                >
                  Clock Out
                </button>
              </div>

              {/* Overhauled Break Planner Selection */}
              {isClockedIn && (
                <div className="break-widget">
                  <div className="break-header">
                    <span className="field-label" style={{ margin: 0 }}>Break Planner</span>
                    <span className="break-allowance">{breakAllowanceMinutesRemaining} min left</span>
                  </div>
                  
                  {!isOnBreak ? (
                    <>
                      {!showCustomBreakForm ? (
                        <div className="break-presets" style={{ gridTemplateColumns: "1fr 1fr" }}>
                          <button 
                            className="preset-btn main-break-btn"
                            disabled={submitting}
                            onClick={() => toggleBreak("lunch", 60)}
                          >
                            <span className="break-btn-icon">🍱</span>
                            <span className="break-btn-title">Lunch Break</span>
                            <span className="time-label">1 Hour</span>
                          </button>
                          <button 
                            className="preset-btn main-break-btn"
                            disabled={submitting}
                            onClick={() => setShowCustomBreakForm(true)}
                          >
                            <span className="break-btn-icon">⚡</span>
                            <span className="break-btn-title">Custom Break</span>
                            <span className="time-label">Configure</span>
                          </button>
                        </div>
                      ) : (
                        <div className="custom-break-form">
                          <p className="custom-break-section-title">Select Duration</p>
                          <div className="custom-break-pill-grid">
                            {[5, 10, 15, 30].map((d) => (
                              <button
                                key={d}
                                type="button"
                                className={`duration-pill ${customBreakDuration === d ? "active" : ""}`}
                                onClick={() => setCustomBreakDuration(d)}
                              >
                                {d}m
                              </button>
                            ))}
                          </div>

                          <p className="custom-break-section-title">Select Type</p>
                          <div className="custom-break-preset-grid">
                            {[
                              { type: "smoke", label: "🚬 Smoke" },
                              { type: "tea", label: "☕ Tea" },
                              { type: "meeting", label: "🤝 Meeting" },
                              { type: "personal", label: "👤 Personal" }
                            ].map((p) => (
                              <button
                                key={p.type}
                                type="button"
                                className={`preset-pill ${customBreakReasonType === p.type ? "active" : ""}`}
                                onClick={() => setCustomBreakReasonType(p.type as any)}
                              >
                                {p.label}
                              </button>
                            ))}
                          </div>

                          <p className="custom-break-section-title">Specify Reason (Optional)</p>
                          <input
                            type="text"
                            className="field custom-break-reason-field"
                            placeholder="e.g. coffee run, quick discussion"
                            value={customBreakCustomReason}
                            onChange={(e) => setCustomBreakCustomReason(e.target.value)}
                          />

                          <div className="custom-break-actions">
                            <button
                              type="button"
                              className="btn btn-clockout custom-break-cancel"
                              onClick={() => {
                                setShowCustomBreakForm(false);
                                setCustomBreakCustomReason("");
                              }}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="btn btn-clockin custom-break-start"
                              onClick={() => {
                                const baseReason = customBreakReasonType;
                                const customDetail = customBreakCustomReason.trim();
                                const finalReason = customDetail ? `${baseReason} - ${customDetail}` : `${baseReason} break`;
                                toggleBreak(finalReason, customBreakDuration);
                                setShowCustomBreakForm(false);
                                setCustomBreakCustomReason("");
                              }}
                            >
                              Start Break
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <button
                      className="btn btn-break-toggle btn-break-active"
                      disabled={submitting || breakLockoutStatus.isLocked}
                      onClick={() => toggleBreak(activeBreak.reason, activeBreak.duration)}
                      style={{
                        background: breakLockoutStatus.isLocked ? "linear-gradient(135deg, #64748b, #475569)" : undefined,
                        cursor: breakLockoutStatus.isLocked ? "not-allowed" : "pointer"
                      }}
                    >
                      {breakLockoutStatus.isLocked ? (
                        <span>Lockout: {breakLockoutStatus.remainingStr} remaining</span>
                      ) : (
                        <span>On active break ({activeBreak.reason === "lunch" ? "lunch" : activeBreak.reason}) - Resume Shift</span>
                      )}
                    </button>
                  )}
                </div>
              )}

              {/* Active Shift Timing Metrics */}
              <div className="metrics-card">
                <div className="metric-row" style={{ borderBottom: "1px solid var(--line)", paddingBottom: "12px", marginBottom: "12px" }}>
                  <span className="metric-label">Workstation Shift</span>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span className="metric-value" style={{ fontSize: "14px", fontWeight: 600 }}>{currentShift.label}</span>
                  </div>
                </div>
                <div className="metric-row">
                  <span className="metric-label">Active Work Duration</span>
                  <span className="metric-value highlight">{formatDuration(shiftMetrics.workedMs)}</span>
                </div>
                <div className="metric-row">
                  <span className="metric-label">Remaining Working Hours</span>
                  <span className="metric-value">{formatDuration(shiftMetrics.remainingMs)}</span>
                </div>
                <div className="metric-row" style={{ borderTop: "1px solid var(--line)", paddingTop: "12px", marginTop: "12px" }}>
                  <span className="metric-label">Total Shift Target</span>
                  <span className="metric-value" style={{ color: "var(--muted)", fontSize: "14px", fontWeight: 600 }}>{formatDuration(shiftMs)}</span>
                </div>
                <div className="metric-row">
                  <span className="metric-label">Total Absence / Away</span>
                  <span 
                    className="metric-value" 
                    style={{ 
                      color: shiftMetrics.totalBreakMs > 120 * 60 * 1000 ? "var(--red)" : "var(--muted)",
                      fontSize: "14px", 
                      fontWeight: shiftMetrics.totalBreakMs > 120 * 60 * 1000 ? 700 : 600
                    }}
                  >
                    {formatDuration(shiftMetrics.totalBreakMs)}
                  </span>
                </div>
                
                <div className="progress-container" style={{ marginTop: "20px" }}>
                  {/* Segmented Visual Horizontal Gauge */}
                  <div className="progress-track" style={{ display: "flex", background: "#e2e8f0" }}>
                    {/* Active worked segment (sky blue) */}
                    <div 
                      style={{ 
                        width: `${Math.min(100, Math.round((shiftMetrics.workedMs / shiftMs) * 100))}%`, 
                        height: "100%", 
                        background: "linear-gradient(90deg, var(--accent-soft), var(--accent))",
                        transition: "width 0.6s cubic-bezier(0.16, 1, 0.3, 1)"
                      }} 
                    />
                    {/* Cumulative absence segment (rose red) */}
                    <div 
                      style={{ 
                        width: `${Math.min(100, Math.round((shiftMetrics.totalBreakMs / shiftMs) * 100))}%`, 
                        height: "100%", 
                        background: "linear-gradient(90deg, #f43f5e, #be123c)",
                        transition: "width 0.6s cubic-bezier(0.16, 1, 0.3, 1)"
                      }} 
                    />
                  </div>
                  
                  {/* Visual Color Legend ribbon */}
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: "8px", fontSize: "10px", fontWeight: 600, color: "var(--muted)" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                      <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "var(--accent)" }} />
                      Active ({Math.min(100, Math.round((shiftMetrics.workedMs / shiftMs) * 100))}%)
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                      <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#f43f5e" }} />
                      Absence ({Math.min(100, Math.round((shiftMetrics.totalBreakMs / shiftMs) * 100))}%)
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                      <span style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#cbd5e1" }} />
                      Remaining ({Math.max(0, 100 - Math.min(100, Math.round((shiftMetrics.workedMs / shiftMs) * 100)) - Math.min(100, Math.round((shiftMetrics.totalBreakMs / shiftMs) * 100)))}%)
                    </span>
                  </div>
                </div>
              </div>

              {/* High Absence Alert Banner (>120 mins) */}
              {isClockedIn && shiftMetrics.totalBreakMs > 120 * 60 * 1000 && (
                <div 
                  style={{
                    marginTop: "16px",
                    padding: "14px 18px",
                    borderRadius: "16px",
                    background: "rgba(239, 68, 68, 0.08)",
                    border: "1px solid rgba(239, 68, 68, 0.2)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px"
                  }}
                >
                  <p style={{ margin: 0, fontSize: "12px", fontWeight: 700, color: "#be123c", display: "flex", alignItems: "center", gap: "6px" }}>
                    ⚠️ HIGH ABSENCE WARNING
                  </p>
                  <p style={{ margin: 0, fontSize: "11px", color: "#475569", lineHeight: "1.5", fontWeight: 500 }}>
                    You have been away from your shift for <strong>{Math.round(shiftMetrics.totalBreakMs / 60000)} minutes</strong> today (exceeds the 120m corporate limit). 
                    Your configured shift is <strong>{currentShift.label}</strong>, but you have been active/present for only <strong>{formatDuration(shiftMetrics.workedMs)}</strong>.
                  </p>
                </div>
              )}

              <div className="status-bar">{statusMessage}</div>
            </div>

            {/* Right Column - Attendance log list/feed */}
            <div className="right-col">
              <div className="feed-header" style={{ gap: "12px", flexWrap: "wrap" }}>
                <span className="feed-title">Shift Activity Timeline</span>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <label htmlFor="calendarDate" className="clock-label" style={{ fontSize: "10px", margin: 0 }}>Workday:</label>
                  <input
                    id="calendarDate"
                    type="date"
                    value={selectedDateStr}
                    onChange={(e) => setSelectedDateStr(e.target.value)}
                    max={getKarachiTodayStr()}
                    style={{
                      border: "1.5px solid #cbd5e1",
                      borderRadius: "10px",
                      padding: "4px 8px",
                      fontSize: "12px",
                      fontWeight: 600,
                      fontFamily: "var(--font-heading)",
                      color: "var(--text)",
                      outline: "none",
                      background: "#ffffff",
                      cursor: "pointer"
                    }}
                  />
                </div>
              </div>

              {/* Premium Glassmorphic Workday Summary Ribbon */}
              <div 
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(3, 1fr)",
                  gap: "10px",
                  padding: "16px",
                  borderRadius: "18px",
                  background: "rgba(255, 255, 255, 0.4)",
                  border: "1px solid var(--line)",
                  marginBottom: "20px",
                  boxShadow: "0 4px 15px rgba(0,0,0,0.01)"
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "4px", textAlign: "center" }}>
                  <span style={{ fontSize: "9px", fontWeight: 700, textTransform: "uppercase", color: "var(--muted)", letterSpacing: "0.05em" }}>Worked Time</span>
                  <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--text)", fontFamily: "var(--font-heading)" }}>
                    {calendarSummary.hasClockedIn ? formatDuration(calendarSummary.workedMs) : "--:--:--"}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "4px", textAlign: "center", borderLeft: "1px solid var(--line)", borderRight: "1px solid var(--line)" }}>
                  <span style={{ fontSize: "9px", fontWeight: 700, textTransform: "uppercase", color: "var(--muted)", letterSpacing: "0.05em" }}>Breaks Taken</span>
                  <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--primary-cyan)", fontFamily: "var(--font-heading)" }}>
                    {calendarSummary.hasClockedIn ? `${Math.round(calendarSummary.breakMs / 60000)} mins` : "0 mins"}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "4px", textAlign: "center" }}>
                  <span style={{ fontSize: "9px", fontWeight: 700, textTransform: "uppercase", color: "var(--muted)", letterSpacing: "0.05em" }}>Punctuality</span>
                  <span 
                    style={{ 
                      fontSize: "12px", 
                      fontWeight: 700, 
                      fontFamily: "var(--font-heading)",
                      color: !calendarSummary.hasClockedIn ? "var(--muted)" : calendarSummary.isLate ? "var(--red)" : "var(--green)"
                    }}
                  >
                    {calendarSummary.statusLabel}
                  </span>
                </div>
              </div>

              <div className="feed-container">
                {todayLogs.length === 0 ? (
                  <div style={{ textAlign: "center", color: "var(--muted)", marginTop: "40px", fontSize: "14px" }}>
                    No actions recorded on this workday.
                  </div>
                ) : (
                  todayLogs.map((log) => (
                    <div key={log.id} className="feed-item">
                      <div className="feed-item-info">
                        <span className="feed-item-title">{log.label}</span>
                        {log.detail && <span className="feed-item-desc">{log.detail}</span>}
                        <span className="feed-item-desc">
                          {new Date(log.timestamp).toLocaleTimeString("en-GB", {
                            timeZone: "Asia/Karachi",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      <span className={`badge ${log.isRed ? "badge-break" : "badge-in"}`}>
                        {log.type === "in" ? "IN" : log.type === "out" ? "OUT" : log.type === "away" ? "AWAY" : "BREAK"}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        )}

        {/* Glassmorphic overlay dialog popup prompt when returning from idle away */}
        {awayDetails && (
          <div className="modal-overlay">
            <div className="modal-card">
              <div className="modal-icon">🚶</div>
              <h3 className="modal-title">Absence Log Registered</h3>
              <p className="modal-desc" style={{ marginBottom: "16px" }}>
                You were away from your laptop for <span>{Math.round(awayDetails.durationSeconds / 60)} minutes</span>.
                Kindly explain the reason for your absence:
              </p>
              
              <textarea
                value={awayJustification}
                onChange={(e) => setAwayJustification(e.target.value)}
                placeholder="e.g. Tea break / Client walkthrough / System update"
                rows={3}
                style={{
                  width: "100%",
                  borderRadius: "14px",
                  border: "1.5px solid #cbd5e1",
                  padding: "12px 16px",
                  fontSize: "13.5px",
                  fontWeight: 500,
                  fontFamily: "var(--font-body)",
                  color: "var(--text)",
                  outline: "none",
                  resize: "none",
                  marginBottom: "24px"
                }}
                disabled={submitting}
              />

              <p className="modal-desc" style={{ fontSize: "12.5px", marginBottom: "16px" }}>
                Select how this absence duration should be classified:
              </p>
              
              <div className="modal-buttons">
                <button
                  className="btn btn-business"
                  disabled={submitting || !awayJustification.trim()}
                  onClick={() => submitInactivityLog("business")}
                >
                  Work / Business Related (Meeting, Offline Work)
                </button>
                <button
                  className="btn btn-personal"
                  disabled={submitting || !awayJustification.trim()}
                  onClick={() => submitInactivityLog("personal")}
                >
                  Personal Away Time (Subtract from Break Allowance)
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Shift Editor Modal Overlay */}
        {isShiftModalOpen && (
          <div className="modal-overlay">
            <div className="modal-card">
              <div className="modal-icon">🕒</div>
              <h3 className="modal-title">Update Shift Timing</h3>
              <p className="modal-desc" style={{ marginBottom: "20px" }}>
                Select your preferred daily office shift. Your active clock counters and lateness limits will recalculate automatically in real-time.
              </p>
              
              <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginBottom: "28px", textAlign: "left" }}>
                {SHIFT_OPTIONS.map((option) => (
                  <label
                    key={option.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "12px",
                      padding: "14px 18px",
                      borderRadius: "14px",
                      border: tempShiftOptionId === option.id ? "2px solid var(--primary-cyan)" : "1.5px solid #cbd5e1",
                      background: tempShiftOptionId === option.id ? "#f0f9ff" : "#ffffff",
                      cursor: "pointer",
                      transition: "all 0.2s ease"
                    }}
                  >
                    <input
                      type="radio"
                      name="tempShiftOption"
                      value={option.id}
                      checked={tempShiftOptionId === option.id}
                      onChange={() => setTempShiftOptionId(option.id)}
                      style={{
                        accentColor: "var(--primary-cyan)",
                        width: "18px",
                        height: "18px"
                      }}
                    />
                    <div>
                      <p style={{ margin: 0, fontWeight: 600, fontSize: "14px", color: "var(--text)" }}>
                        {option.label}
                      </p>
                      <p style={{ margin: 0, fontSize: "11px", color: "var(--muted)", fontWeight: 500 }}>
                        9 Hours Shift • Starts at {option.start}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
              
              <div className="modal-buttons" style={{ flexDirection: "row", gap: "12px" }}>
                <button
                  className="btn btn-clockout"
                  style={{ flex: 1, padding: "14px" }}
                  onClick={() => setIsShiftModalOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-business"
                  style={{ flex: 1, padding: "14px", color: "#fff" }}
                  onClick={() => updateShiftTiming(tempShiftOptionId)}
                >
                  Save Shift
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Meeting Justification Modal Overlay */}
        {showMeetingJustifyModal && (
          <div className="modal-overlay">
            <div className="modal-card">
              <div className="modal-icon">📝</div>
              <h3 className="modal-title">Meeting Justification</h3>
              <p className="modal-desc" style={{ marginBottom: "20px" }}>
                You are returning from a Meeting Break. Kindly provide a justification or summary of the meeting for workstation log reconciliation:
              </p>
              
              <textarea
                value={meetingJustification}
                onChange={(e) => setMeetingJustification(e.target.value)}
                placeholder="e.g. Client alignment call regarding Q3 assets"
                rows={4}
                style={{
                  width: "100%",
                  borderRadius: "14px",
                  border: "1.5px solid #cbd5e1",
                  padding: "12px 16px",
                  fontSize: "13.5px",
                  fontWeight: 500,
                  fontFamily: "var(--font-body)",
                  color: "var(--text)",
                  outline: "none",
                  resize: "none",
                  marginBottom: "28px"
                }}
                disabled={submitting}
              />
              
              <div className="modal-buttons" style={{ flexDirection: "row", gap: "12px" }}>
                <button
                  className="btn btn-clockout"
                  style={{ flex: 1, padding: "14px" }}
                  onClick={() => {
                    setShowMeetingJustifyModal(false);
                    setMeetingJustification("");
                  }}
                  disabled={submitting}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-business"
                  style={{ flex: 1, padding: "14px", color: "#fff" }}
                  onClick={submitMeetingJustification}
                  disabled={submitting || !meetingJustification.trim()}
                >
                  Submit & Resume
                </button>
              </div>
            </div>
          </div>
        )}


      </div>
    </main>
  );
}