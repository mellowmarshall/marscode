import type { EnvironmentProject } from "./models.ts";

interface QualifiableProjectGroup<TProject extends EnvironmentProject> {
  readonly key: string;
  readonly label: string;
  readonly representative: TProject;
  readonly members: ReadonlyArray<{ readonly project: TProject }>;
}

/**
 * Qualifies group labels with their `owner/` prefix when two or more groups would otherwise
 * share the same case-insensitive label.
 */
export function qualifyCollidingGroupLabels<
  TProject extends EnvironmentProject,
  TGroup extends QualifiableProjectGroup<TProject>,
>(
  groups: ReadonlyArray<TGroup>,
  groupScratchProjects: boolean,
  deriveQualifiedLabel: (group: TGroup) => string,
): TGroup[] {
  const labelCounts = new Map<string, number>();
  for (const group of groups) {
    const label = group.label.toLowerCase();
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  }
  return groups.map((group) => {
    if (
      group.members.length < 2 ||
      (groupScratchProjects && group.representative.isScratch) ||
      (labelCounts.get(group.label.toLowerCase()) ?? 0) < 2
    ) {
      return group;
    }
    const label = deriveQualifiedLabel(group);
    return label === group.label ? group : { ...group, label };
  });
}
