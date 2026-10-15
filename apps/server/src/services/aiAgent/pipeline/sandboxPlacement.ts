import type { InitialTopicMetadata } from '@lobechat/types';

/**
 * The cloud-sandbox placement a first send carries onto the topic it creates —
 * an environment directory or a folder on the drive — without the keys it
 * does not set, so an unset one never lands on the row as an explicit blank.
 */
export const pickSandboxPlacement = (
  metadata?: Pick<InitialTopicMetadata, 'sandboxInstanceId' | 'sandboxWorkingDirectory'>,
) => ({
  ...(metadata?.sandboxInstanceId && { sandboxInstanceId: metadata.sandboxInstanceId }),
  ...(metadata?.sandboxWorkingDirectory && {
    sandboxWorkingDirectory: metadata.sandboxWorkingDirectory,
  }),
});
