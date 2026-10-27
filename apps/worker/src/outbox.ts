import * as Constants from "./worker.constants";
import * as Types from "./worker.types";
import * as Utils from "./worker.utils";

export function makeOutbox(binding: SendEmail) {
  return {
    async send(message: EmailMessageBuilder): Promise<string> {
      try {
        const { messageId } = await binding.send(message);

        return messageId;
      } catch (error) {
        const failure = Types.workerSendFailure.safeParse(error);

        if (!failure.success) {
          throw error;
        }

        const { code, message: reason } = failure.data;

        throw Utils.workerProblem(Constants.WORKER_SEND_STATUS.get(code) ?? 400, reason, code);
      }
    },
  };
}
