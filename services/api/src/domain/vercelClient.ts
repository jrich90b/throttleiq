export type VercelDomainResult = {
  configured: boolean;
  projectId?: string;
  teamId?: string;
  domain: string;
  exists: boolean;
  verified?: boolean;
  error?: string;
};

function vercelConfig() {
  const token = String(process.env.VERCEL_API_TOKEN ?? "").trim();
  const projectId = String(process.env.VERCEL_PROJECT_ID ?? "prj_qNDTCc1VboftJIZi2nHqGYdIZTGC").trim();
  const teamId = String(process.env.VERCEL_TEAM_ID ?? "team_vYNXZAEhe2rQpLVMiy04qH6R").trim();
  return { token, projectId, teamId };
}

function vercelProjectUrl(pathname: string, teamId?: string) {
  const url = new URL(`https://api.vercel.com${pathname}`);
  if (teamId) url.searchParams.set("teamId", teamId);
  return url.toString();
}

async function vercelFetch(pathname: string, init?: RequestInit) {
  const { token, teamId } = vercelConfig();
  if (!token) throw new Error("VERCEL_API_TOKEN is not configured on the API server.");
  const resp = await fetch(vercelProjectUrl(pathname, teamId), {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  const data: any = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(String(data?.error?.message ?? data?.message ?? `Vercel request failed with ${resp.status}`));
  }
  return data;
}

export function getVercelAutomationStatus() {
  const { token, projectId, teamId } = vercelConfig();
  return {
    configured: !!token && !!projectId,
    projectId: projectId || undefined,
    teamId: teamId || undefined
  };
}

export async function getVercelDomainStatus(domain: string): Promise<VercelDomainResult> {
  const cleanDomain = domain.trim().toLowerCase();
  const { token, projectId, teamId } = vercelConfig();
  if (!token || !projectId) {
    return {
      configured: false,
      projectId: projectId || undefined,
      teamId: teamId || undefined,
      domain: cleanDomain,
      exists: false,
      error: "VERCEL_API_TOKEN is not configured on the API server."
    };
  }
  try {
    const data = await vercelFetch(`/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(cleanDomain)}`);
    return {
      configured: true,
      projectId,
      teamId: teamId || undefined,
      domain: cleanDomain,
      exists: true,
      verified: data?.verified ?? data?.verification === undefined
    };
  } catch (err: any) {
    const message = String(err?.message ?? err);
    if (/not found|could not find|domain.*not/i.test(message)) {
      return {
        configured: true,
        projectId,
        teamId: teamId || undefined,
        domain: cleanDomain,
        exists: false,
        verified: false
      };
    }
    return {
      configured: true,
      projectId,
      teamId: teamId || undefined,
      domain: cleanDomain,
      exists: false,
      error: message
    };
  }
}

export async function addVercelProjectDomain(domain: string): Promise<VercelDomainResult> {
  const cleanDomain = domain.trim().toLowerCase();
  const { projectId, teamId } = vercelConfig();
  const existing = await getVercelDomainStatus(cleanDomain);
  if (existing.exists) return existing;
  await vercelFetch(`/v10/projects/${encodeURIComponent(projectId)}/domains`, {
    method: "POST",
    body: JSON.stringify({ name: cleanDomain })
  });
  return {
    configured: true,
    projectId,
    teamId: teamId || undefined,
    domain: cleanDomain,
    exists: true,
    verified: false
  };
}
