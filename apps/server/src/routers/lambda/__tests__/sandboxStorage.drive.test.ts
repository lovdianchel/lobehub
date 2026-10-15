// @vitest-environment node
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agents,
  environmentInstances,
  environments,
  projectEnvironments,
  projects,
  users,
  workspaces,
} from '@/database/schemas';
import { SandboxStorageFilesError } from '@/server/services/sandbox/storageFiles';

import { environmentRouter } from '../environment';
import { sandboxStorageRouter } from '../sandboxStorage';

/**
 * The drive and the environments initialized on it, against a real database:
 * what the routers write, what they refuse, and what a shared drive shows each
 * member. Only the execution plane and the entitlement are stubbed; every row
 * is read back from Postgres.
 */
const serverDB = await getTestDB();
const ownerId = 'drive-owner';
const memberId = 'drive-member';
const workspaceId = 'drive-workspace';
const STORAGE_KEY = `ws-org-${workspaceId}`;

const plane = vi.hoisted(() => ({
  copyInstance: vi.fn(),
  createDirectory: vi.fn(),
  deleteFile: vi.fn(),
  deleteInstance: vi.fn(),
  listFiles: vi.fn(),
  readOccupancy: vi.fn(),
  renameFile: vi.fn(),
  writeFile: vi.fn(),
}));

const entitlement = vi.hoisted(() => ({ claim: vi.fn() }));

vi.mock('@/business/server/trpc-middlewares/workspaceAuth', async () => {
  const mod = await vi.importActual<{ trpc: any }>('@/libs/trpc/lambda/init');
  return { wsCompatProcedure: mod.trpc.procedure };
});

vi.mock('@/libs/trpc/lambda/middleware', () => ({
  serverDatabase: async (opts: any) => opts.next({ ctx: { ...opts.ctx, serverDB } }),
}));

vi.mock('@/server/services/sandbox', async () => {
  const binding = await vi.importActual<any>('@/server/services/sandbox/binding');

  return {
    ...binding,
    forgetDriveFolders: vi.fn(),
    resolveSandboxSessionConfig: vi.fn(),
    resolveSandboxStorageClaim: entitlement.claim,
  };
});

vi.mock('@/server/services/market', () => ({
  MarketService: vi.fn(function () {
    return { getSandboxStorageClient: () => plane };
  }),
}));

const asMember = (userId: string) => ({ serverDB, userId, workspaceId }) as any;
const drive = (userId = ownerId) => sandboxStorageRouter.createCaller(asMember(userId));
const definitions = (userId = ownerId) => environmentRouter.createCaller(asMember(userId));

const instancesOf = (environmentId: string) =>
  serverDB
    .select()
    .from(environmentInstances)
    .where(eq(environmentInstances.environmentId, environmentId));

const environmentExists = async (id: string) =>
  (await serverDB.select().from(environments).where(eq(environments.id, id))).length === 1;

const notFound = () => new SandboxStorageFilesError('not found', 404);

const reset = async () => {
  await serverDB.delete(projectEnvironments);
  await serverDB.delete(projects);
  await serverDB.delete(agents);
  await serverDB.delete(environmentInstances);
  await serverDB.delete(environments);
  await serverDB.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await serverDB.delete(users).where(eq(users.id, ownerId));
  await serverDB.delete(users).where(eq(users.id, memberId));
};

beforeEach(async () => {
  await reset();
  await serverDB.insert(users).values([{ id: ownerId }, { id: memberId }]);
  await serverDB
    .insert(workspaces)
    .values({ id: workspaceId, name: 'Team', primaryOwnerId: ownerId, slug: workspaceId });
  entitlement.claim.mockReset().mockResolvedValue({ key: STORAGE_KEY, quotaBytes: 1 });
  plane.copyInstance.mockReset().mockResolvedValue(undefined);
  plane.createDirectory.mockReset().mockImplementation(async ({ path }) => ({ path }));
  plane.deleteFile.mockReset().mockImplementation(async ({ path }) => ({ path }));
  plane.deleteInstance.mockReset().mockResolvedValue(undefined);
  plane.listFiles.mockReset().mockRejectedValue(notFound());
  plane.readOccupancy.mockReset().mockResolvedValue({ held: [], unavailable: false });
  plane.renameFile.mockReset().mockImplementation(async ({ newPath }) => ({ path: newPath }));
  plane.writeFile.mockReset().mockImplementation(async ({ path }) => ({ path }));
});

afterEach(reset);

/** An environment and one folder initialized from it, as the picker makes them. */
const initializeFolder = async (
  userId: string,
  name: string,
  visibility: 'private' | 'public' = 'private',
) => {
  const environment = await definitions(userId).createEnvironment({ name, visibility });
  const instance = await drive(userId).createInstance({
    environmentId: environment.id,
    name,
    workingDirectory: name,
  });

  return { environment, instance };
};

describe('environment definitions', () => {
  it('are written and read without any drive', async () => {
    entitlement.claim.mockResolvedValue(null);

    const created = await definitions().createEnvironment({
      configuration: { bootstrapCommand: 'pip install pandas', kind: 'code' },
      name: 'Python 数据分析',
    });

    expect(await instancesOf(created.id)).toHaveLength(0);
    await expect(definitions().listEnvironments()).resolves.toMatchObject({
      environments: [expect.objectContaining({ id: created.id, name: 'Python 数据分析' })],
    });
    await definitions().updateEnvironment({ id: created.id, name: 'Renamed' });
    await expect(drive().listInstances({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a files environment: a folder of files is a folder on the drive', async () => {
    await expect(
      definitions().createEnvironment({ configuration: { kind: 'files' } as any, name: 'Docs' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses to remove an environment a folder is still initialized from', async () => {
    const { environment, instance } = await initializeFolder(ownerId, 'atlas');

    await expect(definitions().removeEnvironment({ id: environment.id })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'ENVIRONMENT_HAS_INSTANCES',
    });

    await drive().removeInstance({ id: instance.id });
    await definitions().removeEnvironment({ id: environment.id });
    expect(await environmentExists(environment.id)).toBe(false);
  });

  it('refuses an environment a project still uses', async () => {
    const created = await definitions().createEnvironment({ name: 'Bound' });
    const [agent] = await serverDB.insert(agents).values({ userId: ownerId }).returning();
    const [project] = await serverDB
      .insert(projects)
      .values({ coordinatorAgentId: agent.id, identifier: 'BND', name: 'Bound', userId: ownerId })
      .returning();
    await serverDB
      .insert(projectEnvironments)
      .values({ environmentId: created.id, projectId: project.id });

    await expect(definitions().removeEnvironment({ id: created.id })).rejects.toMatchObject({
      message: 'ENVIRONMENT_HAS_INSTANCES',
    });
  });
});

describe('initializing a folder', () => {
  it('creates an environment directory at the root of the drive', async () => {
    const { environment, instance } = await initializeFolder(ownerId, 'atlas');

    expect(instance).toMatchObject({
      environmentId: environment.id,
      kind: 'sandbox',
      providerScope: STORAGE_KEY,
      status: 'pending',
      workingDirectory: 'atlas',
    });
  });

  it('never nests an environment directory', async () => {
    const environment = await definitions().createEnvironment({ name: 'Nested' });

    await expect(
      drive().createInstance({
        environmentId: environment.id,
        name: 'nested',
        workingDirectory: 'projects/nested',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses a folder that already holds work', async () => {
    const environment = await definitions().createEnvironment({ name: 'Busy' });
    plane.listFiles.mockResolvedValue({ entries: [{ name: 'notes.md' }], path: 'busy' });

    await expect(
      drive().createInstance({
        environmentId: environment.id,
        name: 'busy',
        workingDirectory: 'busy',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'FOLDER_NOT_EMPTY' });
    expect(await instancesOf(environment.id)).toHaveLength(0);
  });

  it('removes any environment directory, the first one included', async () => {
    const { environment, instance } = await initializeFolder(ownerId, 'atlas');

    await drive().removeInstance({ id: instance.id });

    expect(plane.deleteInstance).toHaveBeenCalledWith({ name: instance.id, topicId: undefined });
    expect(await instancesOf(environment.id)).toHaveLength(0);
  });

  it('copies an occupied environment directory into a new root folder', async () => {
    const { instance } = await initializeFolder(ownerId, 'atlas');

    const copy = await drive().copyInstance({
      id: instance.id,
      name: 'atlas-copy',
      workingDirectory: 'atlas-copy',
    });

    expect(copy).toMatchObject({ status: 'ready', workingDirectory: 'atlas-copy' });
  });
});

describe('a shared drive', () => {
  it("hides a colleague's private environment directory from the root listing", async () => {
    await initializeFolder(ownerId, 'secret');
    await initializeFolder(ownerId, 'shared', 'public');
    plane.listFiles.mockResolvedValue({
      entries: ['projA', 'secret', 'shared'].map((name) => ({
        isDirectory: true,
        name,
        path: name,
      })),
      path: '',
      truncated: false,
    });

    const asMember = await drive(memberId).listFiles({});
    const asOwner = await drive(ownerId).listFiles({});

    expect(asMember.entries.map((entry) => entry.name)).toEqual(['projA', 'shared']);
    expect(asOwner.entries.map((entry) => entry.name)).toEqual(['projA', 'secret', 'shared']);
    // Nested paths too: a recursive listing of the root reaches inside it.
    plane.listFiles.mockResolvedValue({
      entries: [{ isDirectory: false, name: 'key', path: 'secret/key' }],
      path: '',
      truncated: false,
    });
    expect((await drive(memberId).listFiles({ recursive: true })).entries).toEqual([]);
  });

  it("refuses to open a colleague's private environment directory by name", async () => {
    await initializeFolder(ownerId, 'secret');

    await expect(drive(memberId).listFiles({ path: 'secret' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(drive(memberId).readFile({ path: 'secret/.env' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('lets every member create, rename and delete ordinary folders at the root', async () => {
    await drive(memberId).createDirectory({ path: 'projB' });
    await drive(memberId).renameFile({ newPath: 'projC', path: 'projB' });
    await drive(memberId).removeFile({ path: 'projC', recursive: true });

    expect(plane.createDirectory).toHaveBeenCalledWith({ path: 'projB' });
    expect(plane.renameFile).toHaveBeenCalledWith({ newPath: 'projC', path: 'projB' });
    expect(plane.deleteFile).toHaveBeenCalledWith({ path: 'projC', recursive: true });
  });

  it('keeps every environment directory read-only from outside, its owner included', async () => {
    await initializeFolder(ownerId, 'atlas', 'public');

    for (const call of [
      () => drive(ownerId).writeFile({ content: 'x', path: 'atlas/notes.md' }),
      () => drive(ownerId).createDirectory({ path: 'atlas/sub' }),
      () => drive(memberId).removeFile({ path: 'atlas', recursive: true }),
      () => drive(memberId).renameFile({ newPath: 'atlas-old', path: 'atlas' }),
      () => drive(memberId).renameFile({ newPath: 'atlas/inside', path: 'projA' }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'INSTANCE_READ_ONLY',
      });
    }
    expect(plane.writeFile).not.toHaveBeenCalled();
    expect(plane.deleteFile).not.toHaveBeenCalled();
    expect(plane.renameFile).not.toHaveBeenCalled();
  });
});
