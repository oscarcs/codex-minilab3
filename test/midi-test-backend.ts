import type {
  MidiBackend,
  MidiMessage,
  MidiMessageHandler,
} from "../src/midi/index.js";

export function createMidiTestBackend(
  ports: { inputs: string[]; outputs: string[] } = {
    inputs: ["Test In"],
    outputs: ["Test Out"],
  },
) {
  const state = {
    handler: undefined as MidiMessageHandler | undefined,
    sent: [] as number[][],
    openedNames: [] as string[],
    inputCloses: 0,
    outputCloses: 0,
    inputOpens: 0,
    outputOpens: 0,
    failOutput: false,
    failNextSend: false,
    listFailures: 0,
    inputStatusFailures: 0,
    throwInputClose: false,
  };
  let inputOpen = false;
  let outputOpen = false;

  const backend: MidiBackend = {
    async listPorts() {
      if (state.listFailures > 0) {
        state.listFailures -= 1;
        throw new Error("port enumeration failed");
      }
      return { inputs: [...ports.inputs], outputs: [...ports.outputs] };
    },

    async openInput(name, handler) {
      state.openedNames.push(name);
      state.inputOpens += 1;
      state.handler = handler;
      inputOpen = true;
      let closed = false;
      return {
        isOpen() {
          if (state.inputStatusFailures > 0) {
            state.inputStatusFailures -= 1;
            throw new Error("input status failed");
          }
          return inputOpen && !closed;
        },
        close() {
          if (!closed) state.inputCloses += 1;
          closed = true;
          inputOpen = false;
          if (state.throwInputClose) {
            state.throwInputClose = false;
            throw new Error("input close failed");
          }
        },
      };
    },

    async openOutput(name) {
      state.openedNames.push(name);
      if (state.failOutput) throw new Error("output failed");
      state.outputOpens += 1;
      outputOpen = true;
      let closed = false;
      return {
        isOpen: () => outputOpen && !closed,
        send(message) {
          if (state.failNextSend) {
            state.failNextSend = false;
            throw new Error("write failed");
          }
          state.sent.push([...message]);
        },
        close() {
          if (!closed) state.outputCloses += 1;
          closed = true;
          outputOpen = false;
        },
      };
    },
  };

  return {
    backend,
    state,
    emit(message: MidiMessage) {
      state.handler?.(0, message);
    },
    dropConnection() {
      inputOpen = false;
      outputOpen = false;
    },
  };
}

export async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

export const quietLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
