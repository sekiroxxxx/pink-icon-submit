import { AppError } from './errors.js';

export interface GitHubRepositoryDetails {
  fork: boolean;
  parentFullName: string | null;
}

export interface GitHubRepositoryReader {
  getRepository(repository: string): Promise<GitHubRepositoryDetails>;
}

export interface GitHubPullRequest {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  createdAt: string | null;
}

export interface GitHubPullRequestLookup {
  matching: GitHubPullRequest | null;
  conflicting: GitHubPullRequest | null;
}

export interface GitHubPullRequestClient {
  findPullRequest(repository: string, head: string, marker: string): Promise<GitHubPullRequestLookup>;
  createDraftPullRequest(repository: string, input: {
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<GitHubPullRequest>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pullRequestFromPayload(payload: unknown): GitHubPullRequest {
  const number = isObject(payload) ? payload.number : undefined;
  if (!isObject(payload)
    || typeof number !== 'number'
    || !Number.isInteger(number)
    || number <= 0
    || typeof payload.html_url !== 'string'
    || typeof payload.state !== 'string'
    || typeof payload.draft !== 'boolean'
    || (payload.created_at !== null && typeof payload.created_at !== 'string')) {
    throw new AppError('GITHUB_API_RESPONSE_INVALID', 'GitHub pull request metadata was incomplete.', 502);
  }
  return {
    number,
    url: payload.html_url,
    state: payload.state,
    isDraft: payload.draft,
    createdAt: payload.created_at,
  };
}

export class GitHubApiClient implements GitHubRepositoryReader, GitHubPullRequestClient {
  constructor(
    private readonly token: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async getRepository(repository: string): Promise<GitHubRepositoryDetails> {
    const response = await this.request(`https://api.github.com/repos/${repository}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'x-github-api-version': '2022-11-28',
      },
    }).catch(() => {
      throw new AppError('GITHUB_API_REQUEST_FAILED', 'Unable to read GitHub repository metadata.', 502);
    });
    if (!response.ok) {
      throw new AppError('GITHUB_API_REQUEST_FAILED', 'Unable to read GitHub repository metadata.', 502, {
        status: response.status,
      });
    }
    const payload: unknown = await response.json().catch(() => {
      throw new AppError('GITHUB_API_RESPONSE_INVALID', 'GitHub repository metadata was not valid JSON.', 502);
    });
    if (!isObject(payload) || typeof payload.fork !== 'boolean') {
      throw new AppError('GITHUB_API_RESPONSE_INVALID', 'GitHub repository metadata was incomplete.', 502);
    }
    const parentFullName = isObject(payload.parent) && typeof payload.parent.full_name === 'string'
      ? payload.parent.full_name
      : null;
    return { fork: payload.fork, parentFullName };
  }

  async findPullRequest(repository: string, head: string, marker: string): Promise<GitHubPullRequestLookup> {
    const url = new URL(`https://api.github.com/repos/${repository}/pulls`);
    url.searchParams.set('state', 'all');
    url.searchParams.set('head', head);
    url.searchParams.set('per_page', '100');
    const response = await this.request(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'x-github-api-version': '2022-11-28',
      },
    }).catch(() => {
      throw new AppError('GITHUB_API_REQUEST_FAILED', 'Unable to find an existing GitHub pull request.', 502);
    });
    if (!response.ok) {
      throw new AppError('GITHUB_API_REQUEST_FAILED', 'Unable to find an existing GitHub pull request.', 502, {
        status: response.status,
      });
    }
    const payload: unknown = await response.json().catch(() => {
      throw new AppError('GITHUB_API_RESPONSE_INVALID', 'GitHub pull request lookup was not valid JSON.', 502);
    });
    if (!Array.isArray(payload)) {
      throw new AppError('GITHUB_API_RESPONSE_INVALID', 'GitHub pull request lookup was incomplete.', 502);
    }
    let conflicting: GitHubPullRequest | null = null;
    for (const candidate of payload) {
      if (!isObject(candidate) || (candidate.body !== null && typeof candidate.body !== 'string')) {
        throw new AppError('GITHUB_API_RESPONSE_INVALID', 'GitHub pull request lookup was incomplete.', 502);
      }
      const pullRequest = pullRequestFromPayload(candidate);
      if (candidate.body?.includes(marker)) {
        return { matching: pullRequest, conflicting: null };
      }
      conflicting ??= pullRequest;
    }
    return { matching: null, conflicting };
  }

  async createDraftPullRequest(repository: string, input: {
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<GitHubPullRequest> {
    const response = await this.request(`https://api.github.com/repos/${repository}/pulls`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ ...input, draft: true }),
    }).catch(() => {
      throw new AppError('GITHUB_API_REQUEST_FAILED', 'Unable to create the GitHub Draft PR.', 502);
    });
    if (!response.ok) {
      throw new AppError('GITHUB_API_REQUEST_FAILED', 'Unable to create the GitHub Draft PR.', 502, {
        status: response.status,
      });
    }
    const payload: unknown = await response.json().catch(() => {
      throw new AppError('GITHUB_API_RESPONSE_INVALID', 'GitHub Draft PR creation did not return valid JSON.', 502);
    });
    return pullRequestFromPayload(payload);
  }
}
