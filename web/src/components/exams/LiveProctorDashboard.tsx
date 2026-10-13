'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertOctagon,
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  Eye,
  FileText,
  Filter,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Shield,
  ShieldAlert,
  Unlock,
  Users,
  X,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import type { ExamAuditLogRow, ExamCandidateRow, StudentRow } from '@/lib/types';
import { cn } from '@/lib/utils';

export interface LiveProctorDashboardProps {
  examCode: string;
  examTitle?: string;
  roster?: (StudentRow | ExamCandidateRow)[];
  onClose?: () => void;
  className?: string;
}

export type CandidateStatus = 'normal' | 'warning' | 'critical' | 'submitted' | 'offline';

export interface CandidateProctorState {
  student_code: string;
  full_name: string;
  class_name: string;
  violation_count: number;
  status: CandidateStatus;
  is_active: boolean;
  is_submitted: boolean;
  score?: number | null;
  logs: ExamAuditLogRow[];
  last_heartbeat?: string | null;
}

const CRITICAL_VIOLATIONS = new Set([
  'AUTO_VIOLATION_LIMIT',
  'FULLSCREEN_EXIT',
  'SPLIT_SCREEN_DETECTED',
  'PHONE_MOVED',
  'PROCTOR_FORCE_SUBMIT',
  'WATERMARK_TAMPER',
]);

const VIOLATION_LABELS: Record<string, { label: string; critical: boolean }> = {
  COPY_ATTEMPT: { label: 'Chặn sao chép', critical: false },
  MULTI_TOUCH: { label: 'Vuốt đa chạm', critical: false },
  WINDOW_BLUR: { label: 'Mất tiêu điểm', critical: false },
  TAB_HIDDEN: { label: 'Rời tab / đổi app', critical: false },
  FULLSCREEN_EXIT: { label: 'Thoát toàn màn hình', critical: true },
  SPLIT_SCREEN_DETECTED: { label: 'Chia đôi màn hình', critical: true },
  PHONE_MOVED: { label: 'Nhấc / lắc thiết bị', critical: true },
  AUTO_VIOLATION_LIMIT: { label: 'Hết ngưỡng vi phạm', critical: true },
  WATERMARK_TAMPER: { label: 'Xóa hình mờ', critical: true },
  PROCTOR_FORCE_SUBMIT: { label: 'Giám thị thu bài', critical: true },
  TEACHER_RESET_ATTEMPT: { label: 'Cấp lại lượt thi', critical: false },
  TEACHER_REOPEN_SESSION: { label: 'Mở lại bài thi (+5p)', critical: false },
};

export function LiveProctorDashboard({
  examCode,
  examTitle,
  roster = [],
  onClose,
  className,
}: LiveProctorDashboardProps) {
  const [candidates, setCandidates] = useState<Record<string, CandidateProctorState>>({});
  const [logsList, setLogsList] = useState<ExamAuditLogRow[]>([]);
  const [activeSessionCodes, setActiveSessionCodes] = useState<Set<string>>(new Set());
  const [submittedCodes, setSubmittedCodes] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | CandidateStatus>('all');
  const [selectedCandidate, setSelectedCandidate] = useState<CandidateProctorState | null>(null);
  const [forceSubmitTarget, setForceSubmitTarget] = useState<CandidateProctorState | null>(null);
  const [isForceSubmitting, setIsForceSubmitting] = useState(false);
  const [forceReason, setForceReason] = useState('Giám thị phát hiện vi phạm quy chế');
  const [resetTarget, setResetTarget] = useState<CandidateProctorState | null>(null);
  const [isResetting, setIsResetting] = useState(false);
  const [reopenTarget, setReopenTarget] = useState<CandidateProctorState | null>(null);
  const [isReopening, setIsReopening] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const [notification, setNotification] = useState<{ text: string; type: 'info' | 'warn' | 'error' } | null>(null);

  const showToast = useCallback((text: string, type: 'info' | 'warn' | 'error' = 'info') => {
    setNotification({ text, type });
    setTimeout(() => setNotification(null), 4000);
  }, []);

  // Fetch initial data
  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const supabase = createClient();

      // 1. Fetch Students
      const { data: studentsData } = await supabase
        .from('students')
        .select('student_code, full_name, class_name, exam_code')
        .eq('exam_code', examCode);

      // 2. Fetch Active Sessions
      const { data: sessionsData } = await supabase
        .from('active_sessions')
        .select('student_code, last_heartbeat, blur_count, fullscreen_exit_count')
        .eq('exam_code', examCode);

      // 3. Fetch Exam Results (Submitted)
      const { data: resultsData } = await supabase
        .from('exam_results')
        .select('student_code, score, submitted_at')
        .eq('exam_code', examCode);

      // 4. Fetch Audit Logs
      const { data: logsData } = await supabase
        .from('exam_audit_logs')
        .select('*')
        .eq('exam_code', examCode)
        .order('occurred_at', { ascending: false });

      const actCodes = new Set<string>((sessionsData || []).map((s) => s.student_code.toLowerCase().trim()));
      const subCodes = new Set<string>((resultsData || []).map((r) => r.student_code.toLowerCase().trim()));
      setActiveSessionCodes(actCodes);
      setSubmittedCodes(subCodes);

      const logs = (logsData || []) as ExamAuditLogRow[];
      setLogsList(logs);

      // Index logs by student_code
      const logsByStudent: Record<string, ExamAuditLogRow[]> = {};
      for (const log of logs) {
        const sc = log.student_code.toLowerCase().trim();
        if (!logsByStudent[sc]) logsByStudent[sc] = [];
        logsByStudent[sc].push(log);
      }

      // Build consolidated candidate records
      const allRoster = (studentsData && studentsData.length > 0 ? studentsData : roster) as (StudentRow | ExamCandidateRow)[];
      const nextMap: Record<string, CandidateProctorState> = {};

      for (const st of allRoster) {
        const rawCode = st.student_code;
        const normCode = rawCode.toLowerCase().trim();
        const studentLogs = logsByStudent[normCode] || [];
        const isSub = subCodes.has(normCode) || studentLogs.some((l) => l.violation_type === 'PROCTOR_FORCE_SUBMIT');
        const isAct = actCodes.has(normCode);
        const vCount = studentLogs.length;

        const hasCritical = studentLogs.some((l) => CRITICAL_VIOLATIONS.has(l.violation_type));
        let status: CandidateStatus = 'normal';
        if (isSub) {
          status = 'submitted';
        } else if (hasCritical || vCount >= 3) {
          status = 'critical';
        } else if (vCount > 0) {
          status = 'warning';
        } else if (isAct) {
          status = 'normal';
        } else {
          status = 'offline';
        }

        nextMap[rawCode] = {
          student_code: rawCode,
          full_name: st.full_name,
          class_name: st.class_name,
          violation_count: vCount,
          status,
          is_active: isAct,
          is_submitted: isSub,
          logs: studentLogs,
        };
      }

      setCandidates(nextMap);
    } catch (err) {
      console.error('Failed to load proctor data', err);
      showToast('Lỗi khi tải dữ liệu giám sát', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [examCode, roster, showToast]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Realtime subscription on exam_audit_logs
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`live_proctor_${examCode}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'exam_audit_logs',
          filter: `exam_code=eq.${examCode}`,
        },
        (payload) => {
          const newLog = payload.new as ExamAuditLogRow;
          setLogsList((prev) => [newLog, ...prev]);

          const code = newLog.student_code;
          const normCode = code.toLowerCase().trim();

          setCandidates((prev) => {
            const current = prev[code] || Object.values(prev).find((c) => c.student_code.toLowerCase().trim() === normCode);
            if (!current) return prev;

            const updatedLogs = [newLog, ...(current.logs || [])];
            const vCount = updatedLogs.length;
            const hasCritical = updatedLogs.some((l) => CRITICAL_VIOLATIONS.has(l.violation_type));
            const isSub = current.is_submitted || newLog.violation_type === 'PROCTOR_FORCE_SUBMIT';

            let status: CandidateStatus = 'normal';
            if (isSub) {
              status = 'submitted';
            } else if (hasCritical || vCount >= 3) {
              status = 'critical';
            } else if (vCount > 0) {
              status = 'warning';
            } else if (current.is_active) {
              status = 'normal';
            } else {
              status = 'offline';
            }

            const updated: CandidateProctorState = {
              ...current,
              violation_count: vCount,
              logs: updatedLogs,
              status,
              is_submitted: isSub,
            };

            // Update selected candidate if open
            if (selectedCandidate && selectedCandidate.student_code.toLowerCase().trim() === normCode) {
              setSelectedCandidate(updated);
            }

            return {
              ...prev,
              [current.student_code]: updated,
            };
          });

          const label = VIOLATION_LABELS[newLog.violation_type]?.label || newLog.violation_type;
          showToast(`⚠️ Vi phạm mới từ thí sinh ${code}: ${label}`, 'warn');
        },
      )
      .subscribe((status) => {
        setIsConnected(status === 'SUBSCRIBED');
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [examCode, selectedCandidate, showToast]);

  // Handle Proctor Force Submit
  const handleConfirmForceSubmit = async () => {
    if (!forceSubmitTarget) return;
    setIsForceSubmitting(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.rpc('proctor_force_submit_exam', {
        p_exam_code: examCode,
        p_student_code: forceSubmitTarget.student_code,
        p_reason: forceReason.trim() || 'Giám thị thu bài trực tiếp',
      });

      if (error || !data?.success) {
        throw new Error(data?.message || error?.message || 'Không thể thu bài thí sinh.');
      }

      showToast(`Đã thu bài cưỡng chế cho thí sinh ${forceSubmitTarget.full_name} (${forceSubmitTarget.student_code})`, 'info');

      // Update state locally
      setCandidates((prev) => {
        const target = prev[forceSubmitTarget.student_code];
        if (!target) return prev;
        return {
          ...prev,
          [forceSubmitTarget.student_code]: {
            ...target,
            status: 'submitted',
            is_submitted: true,
            is_active: false,
          },
        };
      });

      setForceSubmitTarget(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Lỗi khi thu bài';
      showToast(msg, 'error');
    } finally {
      setIsForceSubmitting(false);
    }
  };

  // Handle Reset Attempt
  const handleConfirmResetAttempt = async () => {
    if (!resetTarget) return;
    setIsResetting(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.rpc('reset_student_exam_attempt', {
        p_exam_code: examCode,
        p_student_code: resetTarget.student_code,
        p_reason: 'Giáo viên cấp lại lượt thi mới',
      });

      if (error || !data?.success) {
        throw new Error(data?.message || error?.message || 'Không thể cấp lại lượt thi.');
      }

      showToast(`Đã cấp lại lượt thi mới cho thí sinh ${resetTarget.full_name}`, 'info');

      // Update state locally
      setCandidates((prev) => {
        const target = prev[resetTarget.student_code];
        if (!target) return prev;
        return {
          ...prev,
          [resetTarget.student_code]: {
            ...target,
            status: 'offline',
            is_submitted: false,
            is_active: false,
            violation_count: 0,
            logs: [],
          },
        };
      });

      setResetTarget(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Lỗi khi cấp lại lượt thi';
      showToast(msg, 'error');
    } finally {
      setIsResetting(false);
    }
  };

  // Handle Reopen Session
  const handleConfirmReopenSession = async () => {
    if (!reopenTarget) return;
    setIsReopening(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.rpc('reopen_student_exam_session', {
        p_exam_code: examCode,
        p_student_code: reopenTarget.student_code,
        p_extra_minutes: 5,
      });

      if (error || !data?.success) {
        throw new Error(data?.message || error?.message || 'Không thể mở lại bài thi.');
      }

      showToast(`Đã mở lại bài thi và cộng thêm 5 phút cho thí sinh ${reopenTarget.full_name}`, 'info');

      // Update state locally
      setCandidates((prev) => {
        const target = prev[reopenTarget.student_code];
        if (!target) return prev;
        return {
          ...prev,
          [reopenTarget.student_code]: {
            ...target,
            status: 'normal',
            is_submitted: false,
            is_active: true,
          },
        };
      });

      setReopenTarget(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Lỗi khi mở lại bài thi';
      showToast(msg, 'error');
    } finally {
      setIsReopening(false);
    }
  };

  // Aggregated Counters
  const candidateList = useMemo(() => Object.values(candidates), [candidates]);
  const stats = useMemo(() => {
    let normal = 0;
    let warning = 0;
    let critical = 0;
    let submitted = 0;
    let offline = 0;

    for (const c of candidateList) {
      if (c.status === 'submitted') submitted++;
      else if (c.status === 'critical') critical++;
      else if (c.status === 'warning') warning++;
      else if (c.status === 'normal') normal++;
      else offline++;
    }

    return {
      total: candidateList.length,
      normal,
      warning,
      critical,
      submitted,
      offline,
    };
  }, [candidateList]);

  // Filtered Candidates
  const filteredCandidates = useMemo(() => {
    return candidateList.filter((c) => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false;
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase().trim();
        const matchName = c.full_name.toLowerCase().includes(query);
        const matchCode = c.student_code.toLowerCase().includes(query);
        const matchClass = c.class_name.toLowerCase().includes(query);
        if (!matchName && !matchCode && !matchClass) return false;
      }
      return true;
    });
  }, [candidateList, statusFilter, searchQuery]);

  return (
    <div className={cn('relative rounded-2xl border border-slate-200 bg-white/95 shadow-xl backdrop-blur-md', className)}>
      {/* Toast Notification */}
      {notification && (
        <div
          className={cn(
            'absolute right-6 top-6 z-50 flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-semibold shadow-lg transition-all animate-in fade-in slide-in-from-top-2',
            notification.type === 'error' && 'bg-rose-600 text-white',
            notification.type === 'warn' && 'bg-amber-500 text-white',
            notification.type === 'info' && 'bg-indigo-600 text-white',
          )}
        >
          <Radio size={14} className="animate-pulse" />
          <span>{notification.text}</span>
        </div>
      )}

      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 p-5 sm:p-6">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 shadow-xs">
            <Shield className="h-6 w-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-slate-900 sm:text-lg">
                Giám sát phòng thi trực tiếp (Live Proctoring)
              </h2>
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                  isConnected ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700',
                )}
              >
                <span className={cn('h-1.5 w-1.5 rounded-full', isConnected ? 'bg-emerald-500 animate-ping' : 'bg-amber-500')} />
                {isConnected ? 'Realtime Live' : 'Đang kết nối...'}
              </span>
            </div>
            <p className="text-xs text-slate-500">
              Mã đề: <span className="font-mono font-bold text-slate-700">{examCode}</span>
              {examTitle ? ` — ${examTitle}` : ''}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadData()}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw size={13} className={cn(isLoading && 'animate-spin')} />
            Làm mới
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
              title="Đóng bảng giám sát"
            >
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Metric Counters Grid */}
      <div className="grid grid-cols-2 gap-3 border-b border-slate-100 bg-slate-50/50 p-4 sm:grid-cols-5 sm:gap-4 sm:p-6">
        <div className="rounded-xl border border-slate-200/80 bg-white p-3.5 shadow-xs">
          <div className="flex items-center justify-between text-slate-500">
            <span className="text-xs font-medium">Tổng thí sinh</span>
            <Users size={15} className="text-slate-400" />
          </div>
          <div className="mt-2 text-2xl font-extrabold text-slate-900">{stats.total}</div>
        </div>

        <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3.5 shadow-xs">
          <div className="flex items-center justify-between text-emerald-700">
            <span className="text-xs font-semibold">🟢 An toàn</span>
            <CheckCircle2 size={15} className="text-emerald-500" />
          </div>
          <div className="mt-2 text-2xl font-extrabold text-emerald-800">{stats.normal}</div>
        </div>

        <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3.5 shadow-xs">
          <div className="flex items-center justify-between text-amber-700">
            <span className="text-xs font-semibold">🟡 Cảnh báo</span>
            <AlertTriangle size={15} className="text-amber-500" />
          </div>
          <div className="mt-2 text-2xl font-extrabold text-amber-800">{stats.warning}</div>
        </div>

        <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3.5 shadow-xs">
          <div className="flex items-center justify-between text-rose-700">
            <span className="text-xs font-semibold">🔴 Vi phạm nặng</span>
            <ShieldAlert size={15} className="text-rose-500" />
          </div>
          <div className="mt-2 text-2xl font-extrabold text-rose-800">{stats.critical}</div>
        </div>

        <div className="col-span-2 rounded-xl border border-blue-200 bg-blue-50/60 p-3.5 shadow-xs sm:col-span-1">
          <div className="flex items-center justify-between text-blue-700">
            <span className="text-xs font-semibold">📋 Đã nộp bài</span>
            <FileText size={15} className="text-blue-500" />
          </div>
          <div className="mt-2 text-2xl font-extrabold text-blue-800">{stats.submitted}</div>
        </div>
      </div>

      {/* Controls & Filter Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4 sm:px-6">
        <div className="relative min-w-[240px] flex-1 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Tìm theo tên, mã thí sinh hoặc lớp..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-9 pr-3 text-xs placeholder-slate-400 focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <Filter size={13} className="mr-1 text-slate-400" />
          {(
            [
              { id: 'all', label: `Tất cả (${stats.total})` },
              { id: 'normal', label: `🟢 An toàn (${stats.normal})` },
              { id: 'warning', label: `🟡 Cảnh báo (${stats.warning})` },
              { id: 'critical', label: `🔴 Vi phạm (${stats.critical})` },
              { id: 'submitted', label: `Đã nộp (${stats.submitted})` },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setStatusFilter(item.id)}
              className={cn(
                'rounded-lg px-2.5 py-1 font-semibold transition',
                statusFilter === item.id
                  ? 'bg-slate-900 text-white shadow-xs'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Candidate Grid */}
      <div className="p-4 sm:p-6">
        {filteredCandidates.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Users size={36} className="text-slate-300" />
            <p className="mt-3 text-sm font-semibold text-slate-700">Không tìm thấy thí sinh phù hợp</p>
            <p className="text-xs text-slate-400">Hãy thử xóa bộ lọc hoặc kiểm tra lại từ khóa tìm kiếm.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filteredCandidates.map((candidate) => {
              const isCrit = candidate.status === 'critical';
              const isWarn = candidate.status === 'warning';
              const isSub = candidate.status === 'submitted';
              const isNorm = candidate.status === 'normal';

              return (
                <div
                  key={candidate.student_code}
                  className={cn(
                    'group relative flex flex-col justify-between rounded-xl border p-4 transition-all hover:shadow-md',
                    isCrit && 'border-rose-200 bg-rose-50/20 hover:border-rose-300',
                    isWarn && 'border-amber-200 bg-amber-50/20 hover:border-amber-300',
                    isSub && 'border-blue-100 bg-blue-50/10 hover:border-blue-200',
                    isNorm && 'border-slate-200 bg-white hover:border-indigo-200',
                    candidate.status === 'offline' && 'border-slate-200 bg-slate-50/40 opacity-80',
                  )}
                >
                  {/* Card Header: Identity + Badge */}
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-bold text-slate-900 group-hover:text-indigo-600 transition-colors">
                          {candidate.full_name}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1.5 font-mono text-xs text-slate-500">
                          <span>{candidate.student_code}</span>
                          <span>•</span>
                          <span className="font-sans font-medium text-slate-600">{candidate.class_name}</span>
                        </div>
                      </div>

                      {/* Status Pill */}
                      <span
                        className={cn(
                          'inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold shadow-2xs',
                          isCrit && 'bg-rose-100 text-rose-700 border border-rose-200',
                          isWarn && 'bg-amber-100 text-amber-800 border border-amber-200',
                          isSub && 'bg-blue-100 text-blue-700 border border-blue-200',
                          isNorm && 'bg-emerald-100 text-emerald-800 border border-emerald-200',
                          candidate.status === 'offline' && 'bg-slate-100 text-slate-600 border border-slate-200',
                        )}
                      >
                        {isCrit && <ShieldAlert size={12} />}
                        {isWarn && <AlertTriangle size={12} />}
                        {isSub && <CheckCircle2 size={12} />}
                        {isNorm && <Radio size={11} className="text-emerald-600" />}
                        {isCrit
                          ? 'Nguy hiểm'
                          : isWarn
                            ? 'Cảnh báo'
                            : isSub
                              ? 'Đã nộp bài'
                              : isNorm
                                ? 'Đang thi'
                                : 'Chưa vào'}
                      </span>
                    </div>

                    {/* Violation counter */}
                    <div className="mt-3 flex items-center gap-2">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold',
                          candidate.violation_count > 0
                            ? isCrit
                              ? 'bg-rose-500 text-white font-bold'
                              : 'bg-amber-100 text-amber-800'
                            : 'bg-slate-100 text-slate-600',
                        )}
                      >
                        <AlertTriangle size={12} />
                        {candidate.violation_count} vi phạm
                      </span>

                      {candidate.logs.length > 0 && (
                        <span className="truncate text-[11px] text-slate-500">
                          Lần cuối: {new Date(candidate.logs[0].occurred_at).toLocaleTimeString('vi-VN')}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
                    <button
                      type="button"
                      onClick={() => setSelectedCandidate(candidate)}
                      className="inline-flex items-center gap-1 text-xs font-semibold text-slate-700 transition hover:text-indigo-600"
                    >
                      <Eye size={13} />
                      Xem nhật ký ({candidate.logs.length})
                    </button>

                    <div className="flex flex-wrap items-center gap-1.5 justify-end">
                      {!candidate.is_submitted && (
                        <button
                          type="button"
                          onClick={() => {
                            setForceReason('Giám thị thu bài trực tiếp do vi phạm quy chế');
                            setForceSubmitTarget(candidate);
                          }}
                          className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-2 py-1 text-xs font-bold text-rose-700 transition hover:bg-rose-100"
                          title="Buộc thí sinh kết thúc và nộp bài ngay"
                        >
                          <Ban size={12} />
                          Thu bài cưỡng chế
                        </button>
                      )}

                      {candidate.is_submitted && (
                        <button
                          type="button"
                          onClick={() => setReopenTarget(candidate)}
                          className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-bold text-emerald-700 transition hover:bg-emerald-100"
                          title="Mở lại bài thi và gia hạn thêm 5 phút"
                        >
                          <Unlock size={12} />
                          Mở khóa (+5p)
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => setResetTarget(candidate)}
                        className="inline-flex items-center gap-1 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-bold text-amber-700 transition hover:bg-amber-100"
                        title="Xóa bài thi cũ và cấp lại lượt thi mới"
                      >
                        <RotateCcw size={12} />
                        Cấp lại lượt
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Candidate Audit Log Modal / Drawer */}
      {selectedCandidate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs animate-in fade-in">
          <div className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-100 p-5">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  Nhật ký vi phạm: {selectedCandidate.full_name}
                </h3>
                <p className="text-xs text-slate-500">
                  Mã: <span className="font-mono font-bold">{selectedCandidate.student_code}</span> — Lớp:{' '}
                  {selectedCandidate.class_name}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedCandidate(null)}
                className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
              >
                <X size={18} />
              </button>
            </div>

            {/* Event Timeline */}
            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              {selectedCandidate.logs.length === 0 ? (
                <div className="py-8 text-center text-xs text-slate-400">
                  <CheckCircle2 size={32} className="mx-auto mb-2 text-emerald-400" />
                  Thí sinh chưa có ghi nhận vi phạm nào.
                </div>
              ) : (
                selectedCandidate.logs.map((log) => {
                  const meta = VIOLATION_LABELS[log.violation_type];
                  const isCrit = meta?.critical || CRITICAL_VIOLATIONS.has(log.violation_type);

                  return (
                    <div
                      key={log.id}
                      className={cn(
                        'flex items-start gap-3 rounded-xl border p-3 text-xs transition',
                        isCrit ? 'border-rose-200 bg-rose-50/30' : 'border-slate-200 bg-slate-50/50',
                      )}
                    >
                      <div className="mt-0.5">
                        {isCrit ? (
                          <AlertOctagon size={16} className="text-rose-600" />
                        ) : (
                          <AlertTriangle size={16} className="text-amber-500" />
                        )}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={cn(
                              'font-bold',
                              isCrit ? 'text-rose-700' : 'text-slate-800',
                            )}
                          >
                            {meta?.label || log.violation_type}
                          </span>
                          <span className="flex items-center gap-1 font-mono text-[11px] text-slate-400">
                            <Clock size={11} />
                            {new Date(log.occurred_at).toLocaleTimeString('vi-VN')}
                          </span>
                        </div>
                        <p className="mt-1 text-slate-600">{log.violation_message || 'Không có mô tả'}</p>
                        {log.metadata && Object.keys(log.metadata).length > 0 && (
                          <pre className="mt-1.5 rounded bg-slate-100 p-1.5 font-mono text-[10px] text-slate-600 overflow-x-auto">
                            {JSON.stringify(log.metadata, null, 2)}
                          </pre>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50/60 p-4">
              <span className="text-xs text-slate-500">
                Tổng cộng: <strong>{selectedCandidate.logs.length}</strong> sự kiện
              </span>
              <button
                type="button"
                onClick={() => setSelectedCandidate(null)}
                className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition hover:bg-slate-800"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Force Submit Confirm Modal */}
      {forceSubmitTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs animate-in fade-in">
          <div className="w-full max-w-md rounded-2xl border border-rose-200 bg-white p-6 shadow-2xl">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-rose-100 text-rose-600">
                <Ban size={24} />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">Xác nhận thu bài cưỡng chế</h3>
                <p className="text-xs text-slate-500">Thao tác này sẽ chấm dứt bài làm của thí sinh ngay lập tức.</p>
              </div>
            </div>

            <div className="mt-4 rounded-xl bg-slate-50 p-3 text-xs text-slate-700">
              <p>
                Thí sinh: <strong>{forceSubmitTarget.full_name}</strong>
              </p>
              <p>
                Mã: <span className="font-mono">{forceSubmitTarget.student_code}</span> — Lớp:{' '}
                {forceSubmitTarget.class_name}
              </p>
            </div>

            <div className="mt-4">
              <label htmlFor="forceReasonInput" className="text-xs font-semibold text-slate-700">
                Lý do thu bài (sẽ ghi vào biên bản thi):
              </label>
              <input
                id="forceReasonInput"
                type="text"
                value={forceReason}
                onChange={(e) => setForceReason(e.target.value)}
                placeholder="VD: Sử dụng tài liệu hoặc rời khỏi màn hình quá nhiều lần"
                className="mt-1 w-full rounded-lg border border-slate-200 p-2 text-xs text-slate-800 focus:border-rose-500 focus:outline-none"
              />
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setForceSubmitTarget(null)}
                disabled={isForceSubmitting}
                className="rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-100"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmForceSubmit()}
                disabled={isForceSubmitting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-4 py-2 text-xs font-bold text-white shadow-xs transition hover:bg-rose-700 disabled:opacity-50"
              >
                {isForceSubmitting ? <RefreshCw size={13} className="animate-spin" /> : <Ban size={13} />}
                Xác nhận thu bài
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset Attempt Modal */}
      {resetTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs animate-in fade-in">
          <div className="w-full max-w-md rounded-2xl border border-amber-200 bg-white p-6 shadow-2xl">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-amber-100 text-amber-600">
                <RotateCcw size={24} />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">Xác nhận cấp lại lượt thi</h3>
                <p className="text-xs text-slate-500">Cấp phiên làm bài mới tinh cho thí sinh.</p>
              </div>
            </div>

            <div className="mt-4 rounded-xl bg-amber-50/60 border border-amber-200/50 p-3 text-xs text-amber-900">
              <p>
                Thí sinh: <strong>{resetTarget.full_name}</strong>
              </p>
              <p>
                Mã: <span className="font-mono font-bold">{resetTarget.student_code}</span> — Lớp: {resetTarget.class_name}
              </p>
              <p className="mt-2 font-medium text-amber-800">
                ⚠️ Bạn có chắc chắn muốn XÓA bài thi cũ và cấp lại lượt thi mới cho học sinh này? Tất cả dữ liệu bài làm và kết quả cũ sẽ bị xóa hoàn toàn.
              </p>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setResetTarget(null)}
                disabled={isResetting}
                className="rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-100"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmResetAttempt()}
                disabled={isResetting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2 text-xs font-bold text-white shadow-xs transition hover:bg-amber-700 disabled:opacity-50"
              >
                {isResetting ? <RefreshCw size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                Cấp lại lượt thi
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reopen Session Modal */}
      {reopenTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs animate-in fade-in">
          <div className="w-full max-w-md rounded-2xl border border-emerald-200 bg-white p-6 shadow-2xl">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-100 text-emerald-600">
                <Unlock size={24} />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">Mở lại bài thi (+5 phút)</h3>
                <p className="text-xs text-slate-500">Cho phép thí sinh tiếp tục làm bài thêm 5 phút.</p>
              </div>
            </div>

            <div className="mt-4 rounded-xl bg-emerald-50/60 border border-emerald-200/50 p-3 text-xs text-emerald-900">
              <p>
                Thí sinh: <strong>{reopenTarget.full_name}</strong>
              </p>
              <p>
                Mã: <span className="font-mono font-bold">{reopenTarget.student_code}</span> — Lớp: {reopenTarget.class_name}
              </p>
              <p className="mt-2 font-medium text-emerald-800">
                Mở lại bài thi và gia hạn thêm 5 phút cho học sinh? Thí sinh có thể vào lại phòng thi để hoàn thiện bài làm.
              </p>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setReopenTarget(null)}
                disabled={isReopening}
                className="rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-100"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmReopenSession()}
                disabled={isReopening}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-bold text-white shadow-xs transition hover:bg-emerald-700 disabled:opacity-50"
              >
                {isReopening ? <RefreshCw size={13} className="animate-spin" /> : <Unlock size={13} />}
                Mở khóa (+5p)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
