/**
 * Phase 10.6 — Brainstorm Aggregation Helper (1-Student-to-1-Idea Model).
 *
 * In Brainstorm Mode of the Tree of Knowledge, each student contributes exactly ONE idea.
 * This pure helper aggregates submissions into 4 team buckets (Tổ 1..4), deduplicates
 * on student name, sorts alphabetically, and computes ranks based on total approved/participating ideas.
 */

export interface StudentBrainstormEntry {
  id?: string;
  studentName: string;
  ideaText: string;
  isApproved: boolean;
  timestamp: string;
}

export interface TeamBrainstormSummary {
  teamNumber: number;
  teamName: string;
  totalSubmissions: number;
  totalApproved: number;
  rank: number;
  entries: StudentBrainstormEntry[];
}

export interface RawBrainstormSubmission {
  id?: string;
  team_number?: number;
  teamId?: number;
  student_name?: string;
  studentName?: string;
  content?: string;
  text?: string;
  idea?: string;
  answer_text?: string;
  status?: string;
  is_approved?: boolean;
  is_accepted?: boolean;
  created_at?: string;
  submitted_at?: string;
}

export function aggregateBrainstormContributions(
  submissions: RawBrainstormSubmission[]
): TeamBrainstormSummary[] {
  const teamBuckets: Record<number, Map<string, StudentBrainstormEntry>> = {
    1: new Map(),
    2: new Map(),
    3: new Map(),
    4: new Map(),
  };

  submissions.forEach((sub) => {
    const rawNum = Number(sub.team_number ?? sub.teamId ?? 1);
    const tNum = rawNum >= 1 && rawNum <= 4 ? rawNum : 1;
    const sName = (sub.student_name ?? sub.studentName ?? 'Thành viên').trim();
    const ideaContent = (sub.content ?? sub.text ?? sub.idea ?? sub.answer_text ?? '').trim();
    if (!ideaContent) return;

    if (!teamBuckets[tNum]) teamBuckets[tNum] = new Map();

    const isApproved =
      sub.status === 'approved' ||
      sub.status === 'accepted' ||
      sub.is_approved === true ||
      sub.is_accepted === true ||
      sub.status === undefined;

    // 1 student = 1 idea: retain latest if re-submitted
    teamBuckets[tNum].set(sName, {
      id: sub.id,
      studentName: sName,
      ideaText: ideaContent,
      isApproved,
      timestamp: sub.submitted_at || sub.created_at || new Date().toISOString(),
    });
  });

  const teams: TeamBrainstormSummary[] = [1, 2, 3, 4].map((tNum) => {
    const entries = Array.from((teamBuckets[tNum] || new Map()).values()).sort((a, b) =>
      a.studentName.localeCompare(b.studentName, 'vi')
    );
    const totalApproved = entries.filter((e) => e.isApproved).length;

    return {
      teamNumber: tNum,
      teamName: `Tổ ${tNum}`,
      totalSubmissions: entries.length,
      totalApproved,
      rank: 1,
      entries,
    };
  });

  // Rank by total approved ideas descending
  const sorted = [...teams].sort((a, b) => b.totalApproved - a.totalApproved);
  sorted.forEach((team, idx) => {
    team.rank = idx + 1;
  });

  return teams;
}
