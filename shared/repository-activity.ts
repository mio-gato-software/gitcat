/** Conventional PR references only. A generic #number could just be an issue. */
export function pullRequestReference(subject: string): string | undefined {
  return subject.match(/^Merge pull request #(\d+)\b/i)?.[1]
    ?? subject.match(/\(#(\d+)\)\s*$/)?.[1];
}
