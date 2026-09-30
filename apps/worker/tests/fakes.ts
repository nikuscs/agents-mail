import type * as Types from "../src/worker.types";

export function makeOutbox(failure?: Error, during?: () => Promise<void>) {
  const messages: (EmailMessage | EmailMessageBuilder)[] = [];

  const binding: SendEmail = {
    async send(message: EmailMessage | EmailMessageBuilder) {
      if (failure) {
        throw failure;
      }

      await during?.();
      messages.push(message);

      return { messageId: "<sent@example.com>" };
    },
  };

  return { binding, messages };
}

export function failing<T extends object>(target: T, method: keyof T, after = 0): T {
  let calls = 0;

  return new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key);

      if (typeof value !== "function") {
        return value;
      }

      return (...args: T[keyof T][]) => {
        if (key === method) {
          calls += 1;

          if (calls > after) {
            throw new Error(`${String(method)} unavailable`);
          }
        }

        return Reflect.apply(value, object, args);
      };
    },
  });
}

export function makeJev(...answers: [string, number][]) {
  const requests: { state: Record<string, string> }[] = [];

  const fetch: Types.Deps["fetch"] = async (_input, init) => {
    requests.push(await new Response(init?.body).json());

    const [category, injection] = answers.shift() ?? [];

    if (category === undefined || injection === undefined) {
      return Response.json({ error: "down" }, { status: 500 });
    }

    return Response.json({
      model: "jev-latest",
      answers: {
        category: { type: "choice", choice: category, confidence: 0.9, probabilities: { [category]: 0.9 } },
        injection: { type: "noul", noul: injection },
      },
      usage: { input_tokens: 10, output_tokens: 2 },
    });
  };

  return { fetch, requests };
}
