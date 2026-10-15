'use client';

import { Flexbox } from '@lobehub/ui';
import { ActionIcon, Button, confirmModal, Tag, Text, toast } from '@lobehub/ui/base-ui';
import { PackageIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR, { useSWRConfig } from 'swr';

import { useActiveWorkspaceId } from '@/business/client/hooks/useActiveWorkspaceId';
import { describeError } from '@/features/EnvironmentManager/errorMessage';
import { useCanEditEnvironment } from '@/features/EnvironmentManager/useCanEditEnvironment';
import { environmentService } from '@/services/environment';
import { sandboxStorageService } from '@/services/sandboxStorage';

import type { DirectoryEntry, DirectoryListing, DirectorySource } from '../directorySource';
import EnvironmentSelect from '../EnvironmentSelect';
import { openRenameFolderModal } from '../RenameFolderModal';
import {
  displayDrivePath,
  driveParentPath,
  environmentDirectoriesByPath,
  environmentDirectoryState,
  joinDrivePath,
} from './driveFolders';

/** How often a building environment directory is re-listed while the picker shows it. */
const BUILD_REFRESH_MS = 4000;

const FOLDERS_KEY = 'sandbox-drive-folders';

export interface UseSandboxDirectorySourceOptions {
  /**
   * The conversation's agent is shared with the workspace. Such an agent runs
   * on its caller's session, so it cannot run in a private environment's
   * directory — those rows are offered disabled, with the reason.
   */
  agentIsPublic?: boolean;
  /**
   * A team drive: every member's folders share its root, so the root itself
   * is not a folder anyone may work in.
   */
  isSharedDrive: boolean;
  /** An environment directory was picked, or just initialized from a new folder. */
  onPickInstance: (instanceId: string) => void;
  /** Whose run the occupancy answers are relative to; the conversation's own. */
  topicId?: string;
}

/**
 * The cloud sandbox's drive as a directory source, read through
 * `sandboxStorage.listFiles` and written through `createDirectory`.
 *
 * Its root holds two kinds of folder side by side. Ordinary folders are browsed,
 * picked, created, renamed and deleted like any other. Environment directories
 * — folders initialized from a code environment — carry a badge, are picked
 * as a whole by clicking them (binding the conversation to the instance), and
 * are read-only from here; one another conversation is running in says so and
 * offers a fresh copy instead. A colleague's private environment directory is
 * left out by the server altogether.
 */
export const useSandboxDirectorySource = ({
  agentIsPublic,
  isSharedDrive,
  onPickInstance,
  topicId,
}: UseSandboxDirectorySourceOptions): DirectorySource => {
  const { t } = useTranslation(['device', 'setting', 'common']);
  const canEdit = useCanEditEnvironment();
  const workspaceId = useActiveWorkspaceId();
  const { mutate: globalMutate } = useSWRConfig();

  return useMemo(() => {
    const tSetting = (key: string, options?: Record<string, unknown>) =>
      (t as (key: string, options?: Record<string, unknown>) => string)(key, {
        ...options,
        ns: 'setting',
      });
    const refreshFolders = () =>
      globalMutate((key) => Array.isArray(key) && key[0] === FOLDERS_KEY);
    const failed = (error: unknown) =>
      toast.error(describeError(error, tSetting, t('workingDirectory.drive.actionFailed')));

    /** A new instance of the environment, built from its definition, for this conversation. */
    const createCopy = async (environmentId: string) => {
      try {
        const created = await sandboxStorageService.createInstanceForEnvironment({ environmentId });
        void sandboxStorageService.startInstanceBuild({ id: created.id, topicId }).catch(failed);
        onPickInstance(created.id);
      } catch (error) {
        failed(error);
      }
    };

    const folderActions = (entry: { name: string; path: string }) => (
      <Flexbox horizontal gap={2} onClick={(event) => event.stopPropagation()}>
        <ActionIcon
          icon={PencilIcon}
          size={'small'}
          title={t('workingDirectory.drive.rename')}
          onClick={() =>
            openRenameFolderModal({
              currentName: entry.name,
              onSubmit: async (name) => {
                try {
                  await sandboxStorageService.renameFile({
                    newPath: joinDrivePath(driveParentPath(entry.path) ?? '', name),
                    path: entry.path,
                  });
                  await refreshFolders();
                } catch (error) {
                  return describeError(error, tSetting, t('workingDirectory.drive.renameFailed'));
                }
              },
            })
          }
        />
        <ActionIcon
          icon={Trash2Icon}
          size={'small'}
          title={t('workingDirectory.drive.delete')}
          onClick={() =>
            confirmModal({
              cancelText: t('cancel', { ns: 'common' }),
              content: t('workingDirectory.drive.deleteConfirmContent'),
              okButtonProps: { danger: true },
              okText: t('workingDirectory.drive.delete'),
              onOk: async () => {
                try {
                  await sandboxStorageService.removeFile({ path: entry.path, recursive: true });
                  await refreshFolders();
                } catch (error) {
                  failed(error);
                }
              },
              title: t('workingDirectory.drive.deleteConfirmTitle', { name: entry.name }),
            })
          }
        />
      </Flexbox>
    );

    return {
      createFolder: async (parentPath, name, options) => {
        const environmentId = options?.environmentId as string | undefined;
        if (environmentId) {
          // Always at the root, whatever folder is being browsed: environment
          // directories sit side by side there.
          const created = await sandboxStorageService.createInstance({
            environmentId,
            name,
            workingDirectory: name,
          });
          void sandboxStorageService.startInstanceBuild({ id: created.id, topicId }).catch(failed);
          void refreshFolders();
          onPickInstance(created.id);

          return { path: name };
        }

        const path = joinDrivePath(parentPath, name);
        await sandboxStorageService.createDirectory({ path });

        return { path };
      },
      displayPath: displayDrivePath,
      editablePath: false,
      folderErrorKey: (error) => {
        const code = (error as { message?: string })?.message;
        if (code === 'FOLDER_NOT_EMPTY') return 'workingDirectory.drive.folderNotEmpty';
        if (code === 'DUPLICATE_INSTANCE_DIRECTORY' || code === 'OVERLAPPING_INSTANCE_DIRECTORY')
          return 'workingDirectory.drive.folderTaken';
        if (code === 'INSTANCE_READ_ONLY') return 'workingDirectory.drive.readOnly';
      },
      listErrorKey: 'workingDirectory.drive.foldersLoadFailed',
      renderNewFolderOptions: ({ onChange, value }) => (
        <Flexbox gap={4}>
          <Flexbox horizontal align={'center'} gap={8}>
            <Text fontSize={12} style={{ flex: 'none' }} type={'secondary'}>
              {t('workingDirectory.drive.initializeWith')}
            </Text>
            <EnvironmentSelect
              filter={canEdit}
              value={value.environmentId as string | undefined}
              onChange={(environmentId) => onChange({ environmentId })}
            />
          </Flexbox>
          {!!value.environmentId && (
            <Text fontSize={12} type={'secondary'}>
              {t('workingDirectory.drive.initializeHint')}
            </Text>
          )}
        </Flexbox>
      ),
      selectBlockedReason: (path) =>
        isSharedDrive && !path ? t('workingDirectory.drive.rootNotAllowed') : undefined,
      useListing: (path?: string): DirectoryListing => {
        const listingPath = path ?? '';
        const isRoot = !listingPath;

        const folders = useSWR(
          [FOLDERS_KEY, workspaceId ?? '', listingPath],
          () => sandboxStorageService.listFiles({ path: listingPath || undefined }),
          { revalidateOnFocus: false, shouldRetryOnError: false },
        );
        const instances = useSWR(
          isRoot ? ['sandbox-drive-instances', workspaceId ?? '', topicId ?? ''] : null,
          () => sandboxStorageService.listInstances({ topicId, withSizes: false }),
          {
            refreshInterval: (latest) => {
              const listed = latest?.instances ?? [];

              return listed.some((instance) => instance.status === 'pending')
                ? BUILD_REFRESH_MS
                : 0;
            },
            revalidateOnFocus: false,
          },
        );
        const environments = useSWR(
          isRoot ? ['sandbox-drive-environments', workspaceId ?? ''] : null,
          () => environmentService.listEnvironments(),
          { revalidateOnFocus: false },
        );

        const environmentById = new Map(
          (environments.data?.environments ?? []).map((environment) => [
            environment.id,
            environment,
          ]),
        );
        const directories = environmentDirectoriesByPath(
          listingPath,
          instances.data?.instances ?? [],
        );

        const entries: DirectoryEntry[] = (folders.data?.entries ?? [])
          .filter((entry) => entry.isDirectory)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((entry) => {
            const instance = directories.get(entry.path);
            if (!instance) {
              return { actions: folderActions(entry), name: entry.name, path: entry.path };
            }

            const environment = environmentById.get(instance.environmentId);
            const state = environmentDirectoryState(instance);
            const blocked =
              !!agentIsPublic && !!environment?.workspaceId && environment.visibility === 'private';

            // The way out of "in use" sits on the row's second line rather
            // than among its tags: the right edge is where hover actions
            // overlay a row, and a button under them never gets the click.
            const copyable = state === 'inUse' && !!environment && canEdit(environment);

            return {
              description: blocked ? (
                t('workingDirectory.drive.privateBlocked')
              ) : state === 'inUse' ? (
                <Flexbox horizontal align={'center'} gap={8}>
                  <Text fontSize={12} type={'secondary'}>
                    {t('workingDirectory.drive.inUseDesc')}
                  </Text>
                  {copyable && environment && (
                    <Button
                      size={'small'}
                      onClick={(event) => {
                        event.stopPropagation();
                        void createCopy(environment.id);
                      }}
                    >
                      {t('workingDirectory.drive.createCopy')}
                    </Button>
                  )}
                </Flexbox>
              ) : (
                environment?.name
              ),
              disabled: blocked,
              icon: PackageIcon,
              name: entry.name,
              // Picked as a whole: the directory and what its build installed
              // are one choice, and browsing into it would offer its insides
              // as folders of their own.
              onActivate: () => {
                if (state === 'inUse') {
                  toast.info(t('workingDirectory.drive.inUseDesc'));
                  return;
                }
                onPickInstance(instance.id);
              },
              path: entry.path,
              tags: (
                <Flexbox horizontal align={'center'} gap={4}>
                  <Tag color={'processing'} size={'small'}>
                    {t('workingDirectory.drive.environmentBadge')}
                  </Tag>
                  {state !== 'ready' && (
                    <Tag color={state === 'failed' ? 'error' : 'warning'} size={'small'}>
                      {t(`workingDirectory.drive.state.${state}`)}
                    </Tag>
                  )}
                </Flexbox>
              ),
            } satisfies DirectoryEntry;
          });

        return {
          directory: folders.data
            ? { parentPath: driveParentPath(listingPath), path: listingPath }
            : undefined,
          entries,
          error: folders.error,
          hasMore: false,
          isLoading: folders.isLoading || (isRoot && instances.isLoading),
          isLoadingMore: false,
          isRefreshing: folders.isValidating && !folders.isLoading,
          loadMore: () => {},
          refresh: async () => {
            await Promise.all([folders.mutate(), instances.mutate()]);
          },
          retry: () => void folders.mutate(),
        };
      },
    } satisfies DirectorySource;
  }, [
    agentIsPublic,
    canEdit,
    globalMutate,
    isSharedDrive,
    onPickInstance,
    t,
    topicId,
    workspaceId,
  ]);
};
