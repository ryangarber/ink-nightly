import EventEmitter from 'node:events';
import {spy} from 'sinon';

// Fake process.stdout
export type FakeStdout = {
	get: () => string;
	getWrites: () => string[];
} & NodeJS.WriteStream;

const createStdout = (columns?: number, isTTY?: boolean): FakeStdout => {
	const stdout = new EventEmitter() as unknown as FakeStdout;
	stdout.columns = columns ?? 100;
	stdout.isTTY = isTTY ?? true;

	const write = spy((...arguments_: unknown[]) => {
		const callback = arguments_.at(-1);
		if (typeof callback === 'function') {
			queueMicrotask(callback as () => void);
		}

		return true;
	});
	stdout.write = write;

	stdout.get = () =>
		(write.args as string[][]).findLast(args => args[0]?.length > 0)?.[0] ?? '';

	stdout.getWrites = () => (write.args as string[][]).map(args => args[0]!);

	return stdout;
};

export default createStdout;
