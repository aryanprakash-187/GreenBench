export type FileStub = { name: string; size: number } | null;

export type PersonStub = {
  name: string;
  protocol: FileStub;
  schedule: FileStub;
  sampleCount: string;
};

export type Submission = {
  people: PersonStub[];
  submittedAt: string;
};

export function loadSubmission(): Submission | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem("greenbench.submission");
    if (!raw) return null;
    return JSON.parse(raw) as Submission;
  } catch {
    return null;
  }
}

export function namesList(sub: Submission | null): string[] {
  return (
    sub?.people
      ?.map((p) => p.name)
      .filter((n): n is string => !!n && n.trim().length > 0) ?? []
  );
}
