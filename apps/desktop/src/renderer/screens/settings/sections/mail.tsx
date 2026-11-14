/** Settings → Mail: undo send, Follow up, remote images, the image allow-list and how long message text is kept (DESIGN 7.10). */
import { Button } from '../../../ui/buttons-keys';
import { Puck } from '../../../ui/surfaces';
import { Group, InlineLabel, Row, Select } from '../parts';
import {
  FOLLOW_UP_OPTIONS,
  IMAGE_ITEMS,
  REPLY_ITEMS,
  RETENTION_DAY_OPTIONS,
  RETENTION_SIZE_OPTIONS,
  RETENTION_LINE,
  UNDO_SEND_OPTIONS,
  withCurrent,
} from '../settings.model';
import type { SectionProps } from './types';

export function Mail({ data, actions }: SectionProps) {
  const { mail, retention } = data.settings;
  const set = actions.set;
  const gb = retention.maxBodyBytes / 1024 ** 3;
  return (
    <>
      <Group id="set-mail-sending" label="Sending">
        <Row
          section="mail"
          anchor="undoSend"
          description="How long you have to take a message back after Send."
          control={
            <Select
              label="Undo send"
              options={withCurrent(
                UNDO_SEND_OPTIONS,
                String(mail.undoSendSeconds),
                `${mail.undoSendSeconds} seconds`,
              )}
              value={String(mail.undoSendSeconds)}
              onChange={v => void set({ mail: { undoSendSeconds: Number(v) } }, 'change undo send')}
            />
          }
        />
        <Row
          section="mail"
          anchor="defaultReply"
          description="What the Reply button and R start."
          control={
            <Puck
              kind="segmented"
              role="radio"
              label="Reply button"
              items={REPLY_ITEMS}
              selectedId={mail.defaultReply}
              onSelect={v => void set({ mail: { defaultReply: v as typeof mail.defaultReply } })}
            />
          }
        />
        <Row
          section="mail"
          anchor="followUp"
          description="Sent mail with no reply after this long goes under Follow up."
          control={
            <Select
              label="Follow up"
              options={withCurrent(
                FOLLOW_UP_OPTIONS,
                String(mail.followUpDays),
                `${mail.followUpDays} days`,
              )}
              value={String(mail.followUpDays)}
              onChange={v => void set({ mail: { followUpDays: Number(v) } }, 'change Follow up')}
            />
          }
        />
      </Group>

      <Group id="set-mail-images" label="Images">
        <Row
          section="mail"
          anchor="remoteImages"
          description="Images from senders you have not allowed stay hidden."
          control={
            <Puck
              kind="segmented"
              role="radio"
              label="Remote images"
              items={IMAGE_ITEMS}
              selectedId={mail.remoteImages}
              onSelect={v => void set({ mail: { remoteImages: v as typeof mail.remoteImages } })}
            />
          }
        />
        {mail.imageAllowList.length === 0 ? (
          <Row
            section="mail"
            anchor="imageAllowList"
            description="No senders yet. Load images from a sender in the reader to add it here."
          />
        ) : (
          mail.imageAllowList.map(sender => (
            <Row
              key={sender}
              section="mail"
              anchor="imageAllowList"
              idSuffix={sender}
              label={sender}
              description="Images load without asking."
              control={
                <Button
                  variant="text"
                  label="Remove"
                  onPress={() =>
                    void set(
                      { mail: { imageAllowList: mail.imageAllowList.filter(s => s !== sender) } },
                      'remove that sender',
                    )
                  }
                />
              }
            />
          ))
        )}
      </Group>

      <Group id="set-mail-storage" label="Storage">
        <Row
          section="mail"
          anchor="retention"
          description={RETENTION_LINE}
          control={
            <>
              <InlineLabel>for</InlineLabel>
              <Select
                label="Keep message text for"
                options={withCurrent(
                  RETENTION_DAY_OPTIONS,
                  String(retention.bodyDays),
                  `${retention.bodyDays} days`,
                )}
                value={String(retention.bodyDays)}
                onChange={v => void set({ retention: { bodyDays: Number(v) } }, 'change storage')}
              />
              <InlineLabel>up to</InlineLabel>
              <Select
                label="Keep up to"
                options={withCurrent(
                  RETENTION_SIZE_OPTIONS,
                  String(retention.maxBodyBytes),
                  `${gb.toFixed(1)} GB`,
                )}
                value={String(retention.maxBodyBytes)}
                onChange={v =>
                  void set({ retention: { maxBodyBytes: Number(v) } }, 'change storage')
                }
              />
            </>
          }
        />
      </Group>
    </>
  );
}
