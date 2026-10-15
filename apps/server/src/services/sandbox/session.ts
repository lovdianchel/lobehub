import {
  DEFAULT_SANDBOX_MODE,
  isSafeSandboxCwd,
  isSafeSandboxEnvironmentId,
  SANDBOX_DRIVE_ROOT,
  SANDBOX_LOCAL_WORK_ROOT,
  type SandboxMode,
  type SandboxStorageClaim,
} from '@lobechat/builtin-tool-cloud-sandbox';
import type { LobeChatDatabase } from '@lobechat/database';
import type { EnvironmentConfiguration } from '@lobechat/types';
import debug from 'debug';

import { AgentModel } from '@/database/models/agent';
import { EnvironmentInstanceModel } from '@/database/models/environmentInstance';
import { TopicModel } from '@/database/models/topic';

import { isPathWithin, sandboxStorageBinding } from './binding';
import { driveFolderExists } from './driveFolder';
import { resolveSandboxStorageClaim } from './entitlement';
import type { SandboxSessionSpecification } from './types';

const log = debug('lobe-server:sandbox:session');

export type SandboxPlacementFallback =
  'directoryMissing' | 'instanceUnavailable' | 'rootNotAllowed';

export interface SandboxSessionConfig {
  /**
   * The signed entitlement, or `null` when this run gets no persistent
   * workspace. Independent of {@link mode}: the workspace exists whether or not
   * THIS topic writes to it, and the file browser reads it from an ephemeral
   * topic just as well.
   */
  claim: SandboxStorageClaim | null;
  /**
   * The folder the run works in, relative to the drive's root: the chosen
   * folder of a `drive` run, or an instance's directory. Absent on a drive run
   * at the root, and on every ephemeral one.
   */
  cwd?: string;
  /**
   * Snapshot to restore, or `undefined` for the caller's default. This is the
   * INSTANCE's id, not the environment's: what was installed belongs to one
   * instance, so two instances of one environment restore separately and
   * capture separately.
   *
   * Carries the same invariant as {@link SandboxSessionConfig.mode}: a session
   * is bound to one of these on its first call, so every call for a topic has
   * to agree or the snapshot at the end is refused.
   */
  environment?: string;
  /**
   * Why a placement the topic chose was not honoured, when the run fell back
   * to a temporary sandbox because of it. Set only on that fallback, so the
   * composer can say what happened instead of quietly running somewhere the
   * person did not pick:
   *
   * - `directoryMissing` — the folder is no longer on the drive;
   * - `instanceUnavailable` — the environment directory was deleted, is not
   *   this member's to use, or the folder sits inside one;
   * - `rootNotAllowed` — a shared drive's root, which every member's folders
   *   live under, is not a folder anyone may work in.
   */
  fallback?: SandboxPlacementFallback;
  mode: SandboxMode;
  /**
   * What the instance was built from, for the execution plane to act on while
   * the session runs. Absent on an ephemeral run, which has no instance and
   * therefore no definition to honour.
   *
   * The instance's own snapshot of the definition, not the environment's
   * current one — the same object its build used. So the variables a command
   * sees are the ones its packages were installed under, and the digest the
   * execution plane records for a session matches the digest of the build it
   * restored. Editing the environment therefore takes effect on rebuild, which
   * is the same rule the checkout and the installed packages already follow.
   */
  specification?: SandboxSessionSpecification;
  /**
   * Where commands run, when that is not {@link cwd}: the sandbox's local
   * disk, for an instance that has been built from a repository. The checkout
   * lives there and installs only work there; {@link cwd} stays the
   * instance's directory on the volume, which is what the call belongs to —
   * what a shared workspace narrows its view to, and what the file browser
   * reads.
   */
  workingDir?: string;
}

/**
 * The run-time half of a stored definition, named field by field.
 *
 * Everything this omits is either not the execution plane's business during a
 * session or has no business leaving the server at all; see
 * {@link SandboxSessionSpecification}. Absent when the pick is empty, so a
 * definition that says nothing sends nothing rather than an empty object the
 * runtime would still adopt.
 *
 * `kind` is the clearest case of the first: it only picks which form the
 * product shows, and an execution plane that saw it would digest it into every
 * session of every environment that gained one.
 */
const toSessionSpecification = (
  configuration: EnvironmentConfiguration | null | undefined,
): SandboxSessionSpecification | undefined => {
  if (!configuration) return undefined;

  const specification: SandboxSessionSpecification = {
    ...(configuration.bootstrapCommand && { bootstrapCommand: configuration.bootstrapCommand }),
    ...(configuration.env &&
      Object.keys(configuration.env).length > 0 && { env: configuration.env }),
    ...(configuration.excludePaths?.length && { excludePaths: configuration.excludePaths }),
    ...(configuration.internetAccess !== undefined && {
      internetAccess: configuration.internetAccess,
    }),
    ...(configuration.maintenanceCommand && {
      maintenanceCommand: configuration.maintenanceCommand,
    }),
    ...(configuration.sources?.length && { sources: configuration.sources }),
  };

  return Object.keys(specification).length > 0 ? specification : undefined;
};

/**
 * Whether an instance's checkout is on the sandbox's local disk: it has been
 * built, from a definition that clones something. An instance with nothing to
 * clone has no checkout to run in, and one not built yet has nothing there.
 */
const hasLocalCheckout = (instance: {
  configurationSnapshot?: { sources?: { kind?: string }[] } | null;
  status?: string | null;
}): boolean =>
  instance.status === 'ready' &&
  !!instance.configurationSnapshot?.sources?.some((source) => source.kind === 'git');

interface SandboxSessionConfigInput {
  /** See `resolveSandboxStorageClaim` — a visitor run never gets an entitlement. */
  isShareVisitorRun: boolean;
  /**
   * Optional because some runtimes are constructed without one. No database
   * means no plan and no preferences to read, which is exactly the shape of
   * "not entitled" — so the run stays ephemeral rather than half-configured.
   */
  serverDB?: LobeChatDatabase;
  topicId?: string;
  userId: string;
  workspaceId?: string | null;
}

/**
 * Everything the sandbox layer needs to know about persistence for one run,
 * resolved once: the entitlement that goes on the trust token, and the topic's
 * own placement that goes on each request. One of three:
 *
 * - **instance** (`persistent`) — the topic is bound to an environment
 *   directory: its folder plus the packages its build installed;
 * - **drive** — the topic picked a folder on the drive (or its root, in a
 *   personal account): the folder persists, nothing else does;
 * - **temporary** (`ephemeral`) — nothing picked, or a pick that can no
 *   longer be honoured, which then says why in `fallback`.
 *
 * The topic is only consulted when an entitlement exists. Without one the
 * execution plane routes to the ephemeral sandbox whatever the request says, so
 * reading the placement would buy nothing but a query — and deliberately
 * leaving it untouched on the topic is what lets a lapsed subscription pick up
 * exactly where it left off.
 *
 * Never throws; a failed lookup degrades to the ephemeral sandbox every session
 * uses today.
 */
export const resolveSandboxSessionConfig = async ({
  isShareVisitorRun,
  serverDB,
  topicId,
  userId,
  workspaceId,
}: SandboxSessionConfigInput): Promise<SandboxSessionConfig> => {
  if (!serverDB) return { claim: null, mode: DEFAULT_SANDBOX_MODE };

  const claim = await resolveSandboxStorageClaim({
    isShareVisitorRun,
    serverDB,
    userId,
    workspaceId,
  });

  if (!claim || !topicId) {
    log(
      'Ephemeral for topic %s: claim=%s topicId=%s userId=%s workspaceId=%s',
      topicId,
      !!claim,
      !!topicId,
      userId,
      workspaceId,
    );

    return { claim, mode: DEFAULT_SANDBOX_MODE };
  }

  const fallBack = (fallback: SandboxPlacementFallback): SandboxSessionConfig => ({
    claim,
    fallback,
    mode: DEFAULT_SANDBOX_MODE,
  });

  try {
    // Scoped to the workspace the run is in: without it the model reads the
    // personal scope (`workspace_id IS NULL`), a workspace topic never
    // resolves, and every workspace run silently loses its placement.
    const topic = await new TopicModel(serverDB, userId, workspaceId ?? undefined).findById(
      topicId,
    );
    const instanceId = topic?.metadata?.sandboxInstanceId;
    const folder = topic?.metadata?.sandboxWorkingDirectory;

    if (instanceId) {
      // A workspace-public agent runs on its caller's session, and a private
      // environment's captured state can hold that caller's credentials — so
      // a shared agent reads published environments only. Personal mode has
      // no such boundary: its agents default to 'public' without meaning it.
      const callerAgentVisibility =
        workspaceId && topic.agentId
          ? await new AgentModel(serverDB, userId, workspaceId).getAgentVisibility(topic.agentId)
          : null;

      // Deleted, never this member's, or private under a public agent. Any
      // way, the conversation still runs — in a temporary sandbox, and the
      // composer names why — rather than not at all until someone edits a
      // database row.
      const instance = await new EnvironmentInstanceModel(
        serverDB,
        userId,
        workspaceId ?? undefined,
        callerAgentVisibility,
      ).findById(instanceId);
      if (!instance) {
        log(
          'Ignoring unresolvable sandboxInstanceId on topic %s: %o (agentId=%o visibility=%o scope user=%s workspace=%s)',
          topicId,
          instanceId,
          topic.agentId,
          callerAgentVisibility,
          userId,
          workspaceId,
        );

        return fallBack('instanceUnavailable');
      }

      // The directory and the snapshot are one choice, so a bad half discards
      // the whole instance rather than half of it. Running the instance's
      // packages at the drive root would put one instance's files under
      // another's captured state, which is the exact mixing separate instances
      // exist to prevent — and it would do it silently.
      const { id, workingDirectory } = instance;
      if (!isSafeSandboxCwd(workingDirectory) || !isSafeSandboxEnvironmentId(id)) {
        log('Ignoring unusable instance %s on topic %s: %o', id, topicId, workingDirectory);
        return fallBack('instanceUnavailable');
      }

      log('Persistent for topic %s: instance=%s cwd=%o', topicId, id, workingDirectory);

      const specification = toSessionSpecification(instance.configurationSnapshot);

      return {
        claim,
        cwd: workingDirectory,
        environment: id,
        mode: 'persistent',
        ...(specification && { specification }),
        ...(hasLocalCheckout(instance) && { workingDir: SANDBOX_LOCAL_WORK_ROOT }),
      };
    }

    if (folder === undefined) {
      log('Ephemeral for topic %s: no folder picked', topicId);
      return { claim, mode: DEFAULT_SANDBOX_MODE };
    }

    if (folder === SANDBOX_DRIVE_ROOT) {
      // A personal drive is its owner's alone, so its root is a folder like
      // any other. A shared one holds every member's folders, and a session
      // there is narrowed to the one it picked — the root narrows nothing.
      if (workspaceId) return fallBack('rootNotAllowed');

      log('Drive for topic %s at the root of %s', topicId, claim.key);
      return { claim, mode: 'drive' };
    }

    if (!isSafeSandboxCwd(folder)) return fallBack('directoryMissing');

    // An environment directory is written by its own sessions alone, and a
    // colleague's private one is not this member's to read: a folder inside
    // either is not a drive folder, whatever the path says.
    const instanceDirectories = await new EnvironmentInstanceModel(
      serverDB,
      userId,
      workspaceId ?? undefined,
    ).listStorageDirectories(sandboxStorageBinding(claim.key));
    if (instanceDirectories.some((entry) => isPathWithin(folder, entry.workingDirectory))) {
      log('Ignoring a folder inside an instance directory on topic %s: %o', topicId, folder);
      return fallBack('instanceUnavailable');
    }

    // Deleted since it was picked — by this member in another tab, or by a
    // colleague on a shared drive. Recreating it silently would bring back an
    // empty folder under a name someone chose to remove.
    if ((await driveFolderExists({ claim, path: folder, userId, workspaceId })) === false) {
      log('Folder %o on topic %s is no longer on the drive', folder, topicId);
      return fallBack('directoryMissing');
    }

    log('Drive for topic %s: cwd=%o', topicId, folder);
    return { claim, cwd: folder, mode: 'drive' };
  } catch (error) {
    log('Failed to read sandbox preferences for topic %s: %O', topicId, error);
    return { claim, mode: DEFAULT_SANDBOX_MODE };
  }
};
