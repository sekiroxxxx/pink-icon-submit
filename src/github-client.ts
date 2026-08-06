import { AppError } from './errors.js';

export interface GitHubRepositoryDetails {
  fork: boolean;
  parentFullName: string | null;
}

export interface GitHubRepositoryReader {
  getRepository(repository: string): Promise<GitHubRepositoryDetails>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class GitHubApiClient implements GitHubRepositoryReader {
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
}
