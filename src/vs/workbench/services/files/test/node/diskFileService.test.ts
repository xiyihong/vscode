/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { tmpdir } from 'os';
import { FileService } from 'vs/workbench/services/files/common/fileService';
import { Schemas } from 'vs/base/common/network';
import { DiskFileSystemProvider } from 'vs/workbench/services/files/node/diskFileSystemProvider';
import { getRandomTestPath } from 'vs/base/test/node/testUtils';
import { generateUuid } from 'vs/base/common/uuid';
import { join, basename, dirname, posix } from 'vs/base/common/path';
import { getPathFromAmdModule } from 'vs/base/common/amd';
import { copy, rimraf, symlink, RimRafMode, rimrafSync } from 'vs/base/node/pfs';
import { URI } from 'vs/base/common/uri';
import { existsSync, statSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'fs';
import { FileOperation, FileOperationEvent, IFileStat, FileOperationResult, FileSystemProviderCapabilities, FileChangeType, IFileChange, FileChangesEvent, FileOperationError, etag } from 'vs/platform/files/common/files';
import { NullLogService } from 'vs/platform/log/common/log';
import { isLinux, isWindows } from 'vs/base/common/platform';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { isEqual } from 'vs/base/common/resources';
import { VSBuffer, VSBufferReadable } from 'vs/base/common/buffer';

function getByName(root: IFileStat, name: string): IFileStat | null {
	if (root.children === undefined) {
		return null;
	}

	for (const child of root.children) {
		if (child.name === name) {
			return child;
		}
	}

	return null;
}

function toLineByLineReadable(content: string): VSBufferReadable {
	let chunks = content.split('\n');
	chunks = chunks.map((chunk, index) => {
		if (index === 0) {
			return chunk;
		}

		return '\n' + chunk;
	});

	return {
		read(): VSBuffer | null {
			const chunk = chunks.shift();
			if (typeof chunk === 'string') {
				return VSBuffer.fromString(chunk);
			}

			return null;
		}
	};
}

export class TestDiskFileSystemProvider extends DiskFileSystemProvider {

	totalBytesRead: number = 0;

	private _testCapabilities: FileSystemProviderCapabilities;
	get capabilities(): FileSystemProviderCapabilities {
		if (!this._testCapabilities) {
			this._testCapabilities =
				FileSystemProviderCapabilities.FileReadWrite |
				FileSystemProviderCapabilities.FileOpenReadWriteClose |
				FileSystemProviderCapabilities.FileFolderCopy;

			if (isLinux) {
				this._testCapabilities |= FileSystemProviderCapabilities.PathCaseSensitive;
			}
		}

		return this._testCapabilities;
	}

	set capabilities(capabilities: FileSystemProviderCapabilities) {
		this._testCapabilities = capabilities;
	}

	async read(fd: number, pos: number, data: Uint8Array, offset: number, length: number): Promise<number> {
		const bytesRead = await super.read(fd, pos, data, offset, length);

		this.totalBytesRead += bytesRead;

		return bytesRead;
	}

	async readFile(resource: URI): Promise<Uint8Array> {
		const res = await super.readFile(resource);

		this.totalBytesRead += res.byteLength;

		return res;
	}
}

suite('Disk File Service', () => {

	const parentDir = getRandomTestPath(tmpdir(), 'vsctests', 'diskfileservice');
	const testSchema = 'test';

	let service: FileService;
	let fileProvider: TestDiskFileSystemProvider;
	let testProvider: TestDiskFileSystemProvider;
	let testDir: string;

	let disposables: IDisposable[] = [];

	setup(async () => {
		const logService = new NullLogService();

		service = new FileService(logService);
		disposables.push(service);

		fileProvider = new TestDiskFileSystemProvider(logService);
		disposables.push(service.registerProvider(Schemas.file, fileProvider));
		disposables.push(fileProvider);

		testProvider = new TestDiskFileSystemProvider(logService);
		disposables.push(service.registerProvider(testSchema, testProvider));
		disposables.push(testProvider);

		const id = generateUuid();
		testDir = join(parentDir, id);
		const sourceDir = getPathFromAmdModule(require, './fixtures/service');

		await copy(sourceDir, testDir);
	});

	teardown(async () => {
		disposables = dispose(disposables);

		await rimraf(parentDir, RimRafMode.MOVE);
	});

	test('createFolder', async () => {
		let event: FileOperationEvent | undefined;
		disposables.push(service.onAfterOperation(e => event = e));

		const parent = await service.resolve(URI.file(testDir));

		const newFolderResource = URI.file(join(parent.resource.fsPath, 'newFolder'));

		const newFolder = await service.createFolder(newFolderResource);

		assert.equal(newFolder.name, 'newFolder');
		assert.equal(existsSync(newFolder.resource.fsPath), true);

		assert.ok(event);
		assert.equal(event!.resource.fsPath, newFolderResource.fsPath);
		assert.equal(event!.operation, FileOperation.CREATE);
		assert.equal(event!.target!.resource.fsPath, newFolderResource.fsPath);
		assert.equal(event!.target!.isDirectory, true);
	});

	test('createFolder: creating multiple folders at once', async function () {
		let event: FileOperationEvent;
		disposables.push(service.onAfterOperation(e => event = e));

		const multiFolderPaths = ['a', 'couple', 'of', 'folders'];
		const parent = await service.resolve(URI.file(testDir));

		const newFolderResource = URI.file(join(parent.resource.fsPath, ...multiFolderPaths));

		const newFolder = await service.createFolder(newFolderResource);

		const lastFolderName = multiFolderPaths[multiFolderPaths.length - 1];
		assert.equal(newFolder.name, lastFolderName);
		assert.equal(existsSync(newFolder.resource.fsPath), true);

		assert.ok(event!);
		assert.equal(event!.resource.fsPath, newFolderResource.fsPath);
		assert.equal(event!.operation, FileOperation.CREATE);
		assert.equal(event!.target!.resource.fsPath, newFolderResource.fsPath);
		assert.equal(event!.target!.isDirectory, true);
	});

	test('exists', async () => {
		let exists = await service.exists(URI.file(testDir));
		assert.equal(exists, true);

		exists = await service.exists(URI.file(testDir + 'something'));
		assert.equal(exists, false);
	});

	test('resolve', async () => {
		const resolved = await service.resolve(URI.file(testDir), { resolveTo: [URI.file(join(testDir, 'deep'))] });
		assert.equal(resolved.children!.length, 8);

		const deep = (getByName(resolved, 'deep')!);
		assert.equal(deep.children!.length, 4);
	});

	test('resolve - directory', async () => {
		const testsElements = ['examples', 'other', 'index.html', 'site.css'];

		const result = await service.resolve(URI.file(getPathFromAmdModule(require, './fixtures/resolver')));

		assert.ok(result);
		assert.ok(result.children);
		assert.ok(result.children!.length > 0);
		assert.ok(result!.isDirectory);
		assert.equal(result.children!.length, testsElements.length);

		assert.ok(result.children!.every(entry => {
			return testsElements.some(name => {
				return basename(entry.resource.fsPath) === name;
			});
		}));

		result.children!.forEach(value => {
			assert.ok(basename(value.resource.fsPath));
			if (['examples', 'other'].indexOf(basename(value.resource.fsPath)) >= 0) {
				assert.ok(value.isDirectory);
			} else if (basename(value.resource.fsPath) === 'index.html') {
				assert.ok(!value.isDirectory);
				assert.ok(!value.children);
			} else if (basename(value.resource.fsPath) === 'site.css') {
				assert.ok(!value.isDirectory);
				assert.ok(!value.children);
			} else {
				assert.ok(!'Unexpected value ' + basename(value.resource.fsPath));
			}
		});
	});

	test('resolve - directory - with metadata', async () => {
		const testsElements = ['examples', 'other', 'index.html', 'site.css'];

		const result = await service.resolve(URI.file(getPathFromAmdModule(require, './fixtures/resolver')), { resolveMetadata: true });

		assert.ok(result);
		assert.ok(result.children);
		assert.ok(result.children!.length > 0);
		assert.ok(result!.isDirectory);
		assert.equal(result.children!.length, testsElements.length);

		assert.ok(result.children!.every(entry => {
			return testsElements.some(name => {
				return basename(entry.resource.fsPath) === name;
			});
		}));

		assert.ok(result.children!.every(entry => entry.etag.length > 0));

		result.children!.forEach(value => {
			assert.ok(basename(value.resource.fsPath));
			if (['examples', 'other'].indexOf(basename(value.resource.fsPath)) >= 0) {
				assert.ok(value.isDirectory);
			} else if (basename(value.resource.fsPath) === 'index.html') {
				assert.ok(!value.isDirectory);
				assert.ok(!value.children);
			} else if (basename(value.resource.fsPath) === 'site.css') {
				assert.ok(!value.isDirectory);
				assert.ok(!value.children);
			} else {
				assert.ok(!'Unexpected value ' + basename(value.resource.fsPath));
			}
		});
	});

	test('resolve - directory - resolveTo single directory', async () => {
		const resolverFixturesPath = getPathFromAmdModule(require, './fixtures/resolver');
		const result = await service.resolve(URI.file(resolverFixturesPath), { resolveTo: [URI.file(join(resolverFixturesPath, 'other/deep'))] });

		assert.ok(result);
		assert.ok(result.children);
		assert.ok(result.children!.length > 0);
		assert.ok(result.isDirectory);

		const children = result.children!;
		assert.equal(children.length, 4);

		const other = getByName(result, 'other');
		assert.ok(other);
		assert.ok(other!.children!.length > 0);

		const deep = getByName(other!, 'deep');
		assert.ok(deep);
		assert.ok(deep!.children!.length > 0);
		assert.equal(deep!.children!.length, 4);
	});

	test('resolve directory - resolveTo multiple directories', async () => {
		const resolverFixturesPath = getPathFromAmdModule(require, './fixtures/resolver');
		const result = await service.resolve(URI.file(resolverFixturesPath), {
			resolveTo: [
				URI.file(join(resolverFixturesPath, 'other/deep')),
				URI.file(join(resolverFixturesPath, 'examples'))
			]
		});

		assert.ok(result);
		assert.ok(result.children);
		assert.ok(result.children!.length > 0);
		assert.ok(result.isDirectory);

		const children = result.children!;
		assert.equal(children.length, 4);

		const other = getByName(result, 'other');
		assert.ok(other);
		assert.ok(other!.children!.length > 0);

		const deep = getByName(other!, 'deep');
		assert.ok(deep);
		assert.ok(deep!.children!.length > 0);
		assert.equal(deep!.children!.length, 4);

		const examples = getByName(result, 'examples');
		assert.ok(examples);
		assert.ok(examples!.children!.length > 0);
		assert.equal(examples!.children!.length, 4);
	});

	test('resolve directory - resolveSingleChildFolders', async () => {
		const resolverFixturesPath = getPathFromAmdModule(require, './fixtures/resolver/other');
		const result = await service.resolve(URI.file(resolverFixturesPath), { resolveSingleChildDescendants: true });

		assert.ok(result);
		assert.ok(result.children);
		assert.ok(result.children!.length > 0);
		assert.ok(result.isDirectory);

		const children = result.children!;
		assert.equal(children.length, 1);

		let deep = getByName(result, 'deep');
		assert.ok(deep);
		assert.ok(deep!.children!.length > 0);
		assert.equal(deep!.children!.length, 4);
	});

	test('resolves', async () => {
		const res = await service.resolveAll([
			{ resource: URI.file(testDir), options: { resolveTo: [URI.file(join(testDir, 'deep'))] } },
			{ resource: URI.file(join(testDir, 'deep')) }
		]);

		const r1 = (res[0].stat!);
		assert.equal(r1.children!.length, 8);

		const deep = (getByName(r1, 'deep')!);
		assert.equal(deep.children!.length, 4);

		const r2 = (res[1].stat!);
		assert.equal(r2.children!.length, 4);
		assert.equal(r2.name, 'deep');
	});

	test('resolve - folder symbolic link', async () => {
		if (isWindows) {
			return; // not happy
		}

		const link = URI.file(join(testDir, 'deep-link'));
		await symlink(join(testDir, 'deep'), link.fsPath);

		const resolved = await service.resolve(link);
		assert.equal(resolved.children!.length, 4);
		assert.equal(resolved.isDirectory, true);
		assert.equal(resolved.isSymbolicLink, true);
	});

	test('resolve - file symbolic link', async () => {
		if (isWindows) {
			return; // not happy
		}

		const link = URI.file(join(testDir, 'lorem.txt-linked'));
		await symlink(join(testDir, 'lorem.txt'), link.fsPath);

		const resolved = await service.resolve(link);
		assert.equal(resolved.isDirectory, false);
		assert.equal(resolved.isSymbolicLink, true);
	});

	test('resolve - invalid symbolic link does not break', async () => {
		if (isWindows) {
			return; // not happy
		}

		const link = URI.file(join(testDir, 'foo'));
		await symlink(link.fsPath, join(testDir, 'bar'));

		const resolved = await service.resolve(URI.file(testDir));
		assert.equal(resolved.isDirectory, true);
		assert.equal(resolved.children!.length, 8);
	});

	test('deleteFile', async () => {
		let event: FileOperationEvent;
		disposables.push(service.onAfterOperation(e => event = e));

		const resource = URI.file(join(testDir, 'deep', 'conway.js'));
		const source = await service.resolve(resource);

		await service.del(source.resource);

		assert.equal(existsSync(source.resource.fsPath), false);
		assert.ok(event!);
		assert.equal(event!.resource.fsPath, resource.fsPath);
		assert.equal(event!.operation, FileOperation.DELETE);
	});

	test('deleteFolder (recursive)', async () => {
		let event: FileOperationEvent;
		disposables.push(service.onAfterOperation(e => event = e));

		const resource = URI.file(join(testDir, 'deep'));
		const source = await service.resolve(resource);

		await service.del(source.resource, { recursive: true });

		assert.equal(existsSync(source.resource.fsPath), false);
		assert.ok(event!);
		assert.equal(event!.resource.fsPath, resource.fsPath);
		assert.equal(event!.operation, FileOperation.DELETE);
	});

	test('deleteFolder (non recursive)', async () => {
		const resource = URI.file(join(testDir, 'deep'));
		const source = await service.resolve(resource);
		try {
			await service.del(source.resource);

			return Promise.reject(new Error('Unexpected'));
		}
		catch (error) {
			return Promise.resolve(true);
		}
	});

	test('move', async () => {
		let event: FileOperationEvent;
		disposables.push(service.onAfterOperation(e => event = e));

		const source = URI.file(join(testDir, 'index.html'));
		const sourceContents = readFileSync(source.fsPath);

		const target = URI.file(join(dirname(source.fsPath), 'other.html'));

		const renamed = await service.move(source, target);

		assert.equal(existsSync(renamed.resource.fsPath), true);
		assert.equal(existsSync(source.fsPath), false);
		assert.ok(event!);
		assert.equal(event!.resource.fsPath, source.fsPath);
		assert.equal(event!.operation, FileOperation.MOVE);
		assert.equal(event!.target!.resource.fsPath, renamed.resource.fsPath);

		const targetContents = readFileSync(target.fsPath);

		assert.equal(sourceContents.byteLength, targetContents.byteLength);
		assert.equal(sourceContents.toString(), targetContents.toString());
	});

	test('move - across providers (buffered => buffered)', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);
		setCapabilities(testProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		await testMoveAcrossProviders();
	});

	test('move - across providers (unbuffered => unbuffered)', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);
		setCapabilities(testProvider, FileSystemProviderCapabilities.FileReadWrite);

		await testMoveAcrossProviders();
	});

	test('move - across providers (buffered => unbuffered)', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);
		setCapabilities(testProvider, FileSystemProviderCapabilities.FileReadWrite);

		await testMoveAcrossProviders();
	});

	test('move - across providers (unbuffered => buffered)', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);
		setCapabilities(testProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		await testMoveAcrossProviders();
	});

	test('move - across providers - large (buffered => buffered)', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);
		setCapabilities(testProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		await testMoveAcrossProviders('lorem.txt');
	});

	test('move - across providers - large (unbuffered => unbuffered)', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);
		setCapabilities(testProvider, FileSystemProviderCapabilities.FileReadWrite);

		await testMoveAcrossProviders('lorem.txt');
	});

	test('move - across providers - large (buffered => unbuffered)', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);
		setCapabilities(testProvider, FileSystemProviderCapabilities.FileReadWrite);

		await testMoveAcrossProviders('lorem.txt');
	});

	test('move - across providers - large (unbuffered => buffered)', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);
		setCapabilities(testProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		await testMoveAcrossProviders('lorem.txt');
	});

	async function testMoveAcrossProviders(sourceFile = 'index.html'): Promise<void> {
		let event: FileOperationEvent;
		disposables.push(service.onAfterOperation(e => event = e));

		const source = URI.file(join(testDir, sourceFile));
		const sourceContents = readFileSync(source.fsPath);

		const target = URI.file(join(dirname(source.fsPath), 'other.html')).with({ scheme: testSchema });

		const renamed = await service.move(source, target);

		assert.equal(existsSync(renamed.resource.fsPath), true);
		assert.equal(existsSync(source.fsPath), false);
		assert.ok(event!);
		assert.equal(event!.resource.fsPath, source.fsPath);
		assert.equal(event!.operation, FileOperation.COPY);
		assert.equal(event!.target!.resource.fsPath, renamed.resource.fsPath);

		const targetContents = readFileSync(target.fsPath);

		assert.equal(sourceContents.byteLength, targetContents.byteLength);
		assert.equal(sourceContents.toString(), targetContents.toString());
	}

	test('move - multi folder', async () => {
		let event: FileOperationEvent;
		disposables.push(service.onAfterOperation(e => event = e));

		const multiFolderPaths = ['a', 'couple', 'of', 'folders'];
		const renameToPath = join(...multiFolderPaths, 'other.html');

		const source = URI.file(join(testDir, 'index.html'));

		const renamed = await service.move(source, URI.file(join(dirname(source.fsPath), renameToPath)));

		assert.equal(existsSync(renamed.resource.fsPath), true);
		assert.equal(existsSync(source.fsPath), false);
		assert.ok(event!);
		assert.equal(event!.resource.fsPath, source.fsPath);
		assert.equal(event!.operation, FileOperation.MOVE);
		assert.equal(event!.target!.resource.fsPath, renamed.resource.fsPath);
	});

	test('move - directory', async () => {
		let event: FileOperationEvent;
		disposables.push(service.onAfterOperation(e => event = e));

		const source = URI.file(join(testDir, 'deep'));

		const renamed = await service.move(source, URI.file(join(dirname(source.fsPath), 'deeper')));

		assert.equal(existsSync(renamed.resource.fsPath), true);
		assert.equal(existsSync(source.fsPath), false);
		assert.ok(event!);
		assert.equal(event!.resource.fsPath, source.fsPath);
		assert.equal(event!.operation, FileOperation.MOVE);
		assert.equal(event!.target!.resource.fsPath, renamed.resource.fsPath);
	});

	test('move - directory - across providers (buffered => buffered)', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);
		setCapabilities(testProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		await testMoveFolderAcrossProviders();
	});

	test('move - directory - across providers (unbuffered => unbuffered)', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);
		setCapabilities(testProvider, FileSystemProviderCapabilities.FileReadWrite);

		await testMoveFolderAcrossProviders();
	});

	test('move - directory - across providers (buffered => unbuffered)', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);
		setCapabilities(testProvider, FileSystemProviderCapabilities.FileReadWrite);

		await testMoveFolderAcrossProviders();
	});

	test('move - directory - across providers (unbuffered => buffered)', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);
		setCapabilities(testProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		await testMoveFolderAcrossProviders();
	});

	async function testMoveFolderAcrossProviders(): Promise<void> {
		let event: FileOperationEvent;
		disposables.push(service.onAfterOperation(e => event = e));

		const source = URI.file(join(testDir, 'deep'));
		const sourceChildren = readdirSync(source.fsPath);

		const target = URI.file(join(dirname(source.fsPath), 'deeper')).with({ scheme: testSchema });

		const renamed = await service.move(source, target);

		assert.equal(existsSync(renamed.resource.fsPath), true);
		assert.equal(existsSync(source.fsPath), false);
		assert.ok(event!);
		assert.equal(event!.resource.fsPath, source.fsPath);
		assert.equal(event!.operation, FileOperation.COPY);
		assert.equal(event!.target!.resource.fsPath, renamed.resource.fsPath);

		const targetChildren = readdirSync(target.fsPath);
		assert.equal(sourceChildren.length, targetChildren.length);
		for (let i = 0; i < sourceChildren.length; i++) {
			assert.equal(sourceChildren[i], targetChildren[i]);
		}
	}

	test('move - MIX CASE', async () => {
		let event: FileOperationEvent;
		disposables.push(service.onAfterOperation(e => event = e));

		const source = URI.file(join(testDir, 'index.html'));
		await service.resolve(source);

		const renamed = await service.move(source, URI.file(join(dirname(source.fsPath), 'INDEX.html')));

		assert.equal(existsSync(renamed.resource.fsPath), true);
		assert.equal(basename(renamed.resource.fsPath), 'INDEX.html');
		assert.ok(event!);
		assert.equal(event!.resource.fsPath, source.fsPath);
		assert.equal(event!.operation, FileOperation.MOVE);
		assert.equal(event!.target!.resource.fsPath, renamed.resource.fsPath);
	});

	test('move - source parent of target', async () => {
		let event: FileOperationEvent;
		disposables.push(service.onAfterOperation(e => event = e));

		await service.resolve(URI.file(join(testDir, 'index.html')));
		try {
			await service.move(URI.file(testDir), URI.file(join(testDir, 'binary.txt')));
		} catch (e) {
			assert.ok(e);
			assert.ok(!event!);
		}
	});

	test('move - FILE_MOVE_CONFLICT', async () => {
		let event: FileOperationEvent;
		disposables.push(service.onAfterOperation(e => event = e));

		const source = await service.resolve(URI.file(join(testDir, 'index.html')));
		try {
			await service.move(source.resource, URI.file(join(testDir, 'binary.txt')));
		} catch (e) {
			assert.equal(e.fileOperationResult, FileOperationResult.FILE_MOVE_CONFLICT);
			assert.ok(!event!);
		}
	});

	test('move - overwrite folder with file', async () => {
		let createEvent: FileOperationEvent;
		let moveEvent: FileOperationEvent;
		let deleteEvent: FileOperationEvent;
		disposables.push(service.onAfterOperation(e => {
			if (e.operation === FileOperation.CREATE) {
				createEvent = e;
			} else if (e.operation === FileOperation.DELETE) {
				deleteEvent = e;
			} else if (e.operation === FileOperation.MOVE) {
				moveEvent = e;
			}
		}));

		const parent = await service.resolve(URI.file(testDir));
		const folderResource = URI.file(join(parent.resource.fsPath, 'conway.js'));
		const f = await service.createFolder(folderResource);
		const source = URI.file(join(testDir, 'deep', 'conway.js'));

		const moved = await service.move(source, f.resource, true);

		assert.equal(existsSync(moved.resource.fsPath), true);
		assert.ok(statSync(moved.resource.fsPath).isFile);
		assert.ok(createEvent!);
		assert.ok(deleteEvent!);
		assert.ok(moveEvent!);
		assert.equal(moveEvent!.resource.fsPath, source.fsPath);
		assert.equal(moveEvent!.target!.resource.fsPath, moved.resource.fsPath);
		assert.equal(deleteEvent!.resource.fsPath, folderResource.fsPath);
	});

	test('copy', async () => {
		await doTestCopy();
	});

	test('copy - unbuffered (FileSystemProviderCapabilities.FileReadWrite)', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);

		await doTestCopy();
	});

	test('copy - unbuffered large (FileSystemProviderCapabilities.FileReadWrite)', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);

		await doTestCopy('lorem.txt');
	});

	test('copy - buffered (FileSystemProviderCapabilities.FileOpenReadWriteClose)', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		await doTestCopy();
	});

	test('copy - buffered large (FileSystemProviderCapabilities.FileOpenReadWriteClose)', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		await doTestCopy('lorem.txt');
	});

	function setCapabilities(provider: TestDiskFileSystemProvider, capabilities: FileSystemProviderCapabilities): void {
		provider.capabilities = capabilities;
		if (isLinux) {
			provider.capabilities |= FileSystemProviderCapabilities.PathCaseSensitive;
		}
	}

	async function doTestCopy(sourceName: string = 'index.html') {
		let event: FileOperationEvent;
		disposables.push(service.onAfterOperation(e => event = e));

		const source = await service.resolve(URI.file(join(testDir, sourceName)));
		const target = URI.file(join(testDir, 'other.html'));

		const copied = await service.copy(source.resource, target);

		assert.equal(existsSync(copied.resource.fsPath), true);
		assert.equal(existsSync(source.resource.fsPath), true);
		assert.ok(event!);
		assert.equal(event!.resource.fsPath, source.resource.fsPath);
		assert.equal(event!.operation, FileOperation.COPY);
		assert.equal(event!.target!.resource.fsPath, copied.resource.fsPath);

		const sourceContents = readFileSync(source.resource.fsPath);
		const targetContents = readFileSync(target.fsPath);

		assert.equal(sourceContents.byteLength, targetContents.byteLength);
		assert.equal(sourceContents.toString(), targetContents.toString());
	}

	test('copy - overwrite folder with file', async () => {
		let createEvent: FileOperationEvent;
		let copyEvent: FileOperationEvent;
		let deleteEvent: FileOperationEvent;
		disposables.push(service.onAfterOperation(e => {
			if (e.operation === FileOperation.CREATE) {
				createEvent = e;
			} else if (e.operation === FileOperation.DELETE) {
				deleteEvent = e;
			} else if (e.operation === FileOperation.COPY) {
				copyEvent = e;
			}
		}));

		const parent = await service.resolve(URI.file(testDir));
		const folderResource = URI.file(join(parent.resource.fsPath, 'conway.js'));
		const f = await service.createFolder(folderResource);
		const source = URI.file(join(testDir, 'deep', 'conway.js'));

		const copied = await service.copy(source, f.resource, true);

		assert.equal(existsSync(copied.resource.fsPath), true);
		assert.ok(statSync(copied.resource.fsPath).isFile);
		assert.ok(createEvent!);
		assert.ok(deleteEvent!);
		assert.ok(copyEvent!);
		assert.equal(copyEvent!.resource.fsPath, source.fsPath);
		assert.equal(copyEvent!.target!.resource.fsPath, copied.resource.fsPath);
		assert.equal(deleteEvent!.resource.fsPath, folderResource.fsPath);
	});

	test('copy - MIX CASE', async () => {
		const source = await service.resolve(URI.file(join(testDir, 'index.html')));
		const renamed = await service.move(source.resource, URI.file(join(dirname(source.resource.fsPath), 'CONWAY.js')));
		assert.equal(existsSync(renamed.resource.fsPath), true);
		assert.ok(readdirSync(testDir).some(f => f === 'CONWAY.js'));

		const source_1 = await service.resolve(URI.file(join(testDir, 'deep', 'conway.js')));
		const targetParent = URI.file(testDir);
		const target = targetParent.with({ path: posix.join(targetParent.path, posix.basename(source_1.resource.path)) });

		const res = await service.copy(source_1.resource, target, true);
		assert.equal(existsSync(res.resource.fsPath), true);
		assert.ok(readdirSync(testDir).some(f => f === 'conway.js'));
	});

	test('copy - same file should throw', async () => {
		const source = await service.resolve(URI.file(join(testDir, 'index.html')));
		const targetParent = URI.file(dirname(source.resource.fsPath));
		const target = targetParent.with({ path: posix.join(targetParent.path, posix.basename(source.resource.path)) });

		try {
			await service.copy(source.resource, target, true);
		} catch (error) {
			assert.ok(error);
		}
	});

	test('readFile - small file - buffered', () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		return testReadFile(URI.file(join(testDir, 'small.txt')));
	});

	test('readFile - small file - unbuffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);

		return testReadFile(URI.file(join(testDir, 'small.txt')));
	});

	test('readFile - large file - buffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		return testReadFile(URI.file(join(testDir, 'lorem.txt')));
	});

	test('readFile - large file - unbuffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);

		return testReadFile(URI.file(join(testDir, 'lorem.txt')));
	});

	async function testReadFile(resource: URI): Promise<void> {
		const content = await service.readFile(resource);

		assert.equal(content.value.toString(), readFileSync(resource.fsPath));
	}

	test('readFile - Files are intermingled #38331 - buffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		let resource1 = URI.file(join(testDir, 'lorem.txt'));
		let resource2 = URI.file(join(testDir, 'some_utf16le.css'));

		// load in sequence and keep data
		const value1 = await service.readFile(resource1);
		const value2 = await service.readFile(resource2);

		// load in parallel in expect the same result
		const result = await Promise.all([
			service.readFile(resource1),
			service.readFile(resource2)
		]);

		assert.equal(result[0].value.toString(), value1.value.toString());
		assert.equal(result[1].value.toString(), value2.value.toString());
	});

	test('readFile - Files are intermingled #38331 - unbuffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);

		let resource1 = URI.file(join(testDir, 'lorem.txt'));
		let resource2 = URI.file(join(testDir, 'some_utf16le.css'));

		// load in sequence and keep data
		const value1 = await service.readFile(resource1);
		const value2 = await service.readFile(resource2);

		// load in parallel in expect the same result
		const result = await Promise.all([
			service.readFile(resource1),
			service.readFile(resource2)
		]);

		assert.equal(result[0].value.toString(), value1.value.toString());
		assert.equal(result[1].value.toString(), value2.value.toString());
	});

	test('readFile - from position (ASCII) - buffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		const resource = URI.file(join(testDir, 'small.txt'));

		const contents = await service.readFile(resource, { position: 6 });

		assert.equal(contents.value.toString(), 'File');
	});

	test('readFile - from position (with umlaut) - buffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		const resource = URI.file(join(testDir, 'small_umlaut.txt'));

		const contents = await service.readFile(resource, { position: Buffer.from('Small File with Ü').length });

		assert.equal(contents.value.toString(), 'mlaut');
	});

	test('readFile - from position (ASCII) - unbuffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);

		const resource = URI.file(join(testDir, 'small.txt'));

		const contents = await service.readFile(resource, { position: 6 });

		assert.equal(contents.value.toString(), 'File');
	});

	test('readFile - from position (with umlaut) - unbuffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);

		const resource = URI.file(join(testDir, 'small_umlaut.txt'));

		const contents = await service.readFile(resource, { position: Buffer.from('Small File with Ü').length });

		assert.equal(contents.value.toString(), 'mlaut');
	});


	test('readFile - 3 bytes (ASCII) - buffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		const resource = URI.file(join(testDir, 'small.txt'));

		const contents = await service.readFile(resource, { length: 3 });

		assert.equal(contents.value.toString(), 'Sma');
	});

	test('readFile - 3 bytes (ASCII) - unbuffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);

		const resource = URI.file(join(testDir, 'small.txt'));

		const contents = await service.readFile(resource, { length: 3 });

		assert.equal(contents.value.toString(), 'Sma');
	});

	test('readFile - 20000 bytes (large) - buffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		const resource = URI.file(join(testDir, 'lorem.txt'));

		const contents = await service.readFile(resource, { length: 20000 });

		assert.equal(contents.value.byteLength, 20000);
	});

	test('readFile - 20000 bytes (large) - unbuffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);

		const resource = URI.file(join(testDir, 'lorem.txt'));

		const contents = await service.readFile(resource, { length: 20000 });

		assert.equal(contents.value.byteLength, 20000);
	});

	test('readFile - 80000 bytes (large) - buffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		const resource = URI.file(join(testDir, 'lorem.txt'));

		const contents = await service.readFile(resource, { length: 80000 });

		assert.equal(contents.value.byteLength, 80000);
	});

	test('readFile - 80000 bytes (large) - unbuffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);

		const resource = URI.file(join(testDir, 'lorem.txt'));

		const contents = await service.readFile(resource, { length: 80000 });

		assert.equal(contents.value.byteLength, 80000);
	});

	test('readFile - FILE_IS_DIRECTORY', async () => {
		const resource = URI.file(join(testDir, 'deep'));

		let error: FileOperationError | undefined = undefined;
		try {
			await service.readFile(resource);
		} catch (err) {
			error = err;
		}

		assert.ok(error);
		assert.equal(error!.fileOperationResult, FileOperationResult.FILE_IS_DIRECTORY);
	});

	test('readFile - FILE_NOT_FOUND', async () => {
		const resource = URI.file(join(testDir, '404.html'));

		let error: FileOperationError | undefined = undefined;
		try {
			await service.readFile(resource);
		} catch (err) {
			error = err;
		}

		assert.ok(error);
		assert.equal(error!.fileOperationResult, FileOperationResult.FILE_NOT_FOUND);
	});

	test('readFile - FILE_NOT_MODIFIED_SINCE - buffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		const resource = URI.file(join(testDir, 'index.html'));

		const contents = await service.readFile(resource);
		fileProvider.totalBytesRead = 0;

		let error: FileOperationError | undefined = undefined;
		try {
			await service.readFile(resource, { etag: contents.etag });
		} catch (err) {
			error = err;
		}

		assert.ok(error);
		assert.equal(error!.fileOperationResult, FileOperationResult.FILE_NOT_MODIFIED_SINCE);
		assert.equal(fileProvider.totalBytesRead, 0);
	});

	test('readFile - FILE_NOT_MODIFIED_SINCE - unbuffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);

		const resource = URI.file(join(testDir, 'index.html'));

		const contents = await service.readFile(resource);
		fileProvider.totalBytesRead = 0;

		let error: FileOperationError | undefined = undefined;
		try {
			await service.readFile(resource, { etag: contents.etag });
		} catch (err) {
			error = err;
		}

		assert.ok(error);
		assert.equal(error!.fileOperationResult, FileOperationResult.FILE_NOT_MODIFIED_SINCE);
		assert.equal(fileProvider.totalBytesRead, 0);
	});

	test('readFile - FILE_EXCEED_MEMORY_LIMIT - buffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		const resource = URI.file(join(testDir, 'index.html'));

		let error: FileOperationError | undefined = undefined;
		try {
			await service.readFile(resource, { limits: { memory: 10 } });
		} catch (err) {
			error = err;
		}

		assert.ok(error);
		assert.equal(error!.fileOperationResult, FileOperationResult.FILE_EXCEED_MEMORY_LIMIT);
	});

	test('readFile - FILE_EXCEED_MEMORY_LIMIT - unbuffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);

		const resource = URI.file(join(testDir, 'index.html'));

		let error: FileOperationError | undefined = undefined;
		try {
			await service.readFile(resource, { limits: { memory: 10 } });
		} catch (err) {
			error = err;
		}

		assert.ok(error);
		assert.equal(error!.fileOperationResult, FileOperationResult.FILE_EXCEED_MEMORY_LIMIT);
	});

	test('readFile - FILE_TOO_LARGE - buffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		const resource = URI.file(join(testDir, 'index.html'));

		let error: FileOperationError | undefined = undefined;
		try {
			await service.readFile(resource, { limits: { size: 10 } });
		} catch (err) {
			error = err;
		}

		assert.ok(error);
		assert.equal(error!.fileOperationResult, FileOperationResult.FILE_TOO_LARGE);
	});

	test('readFile - FILE_TOO_LARGE - unbuffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);

		const resource = URI.file(join(testDir, 'index.html'));

		let error: FileOperationError | undefined = undefined;
		try {
			await service.readFile(resource, { limits: { size: 10 } });
		} catch (err) {
			error = err;
		}

		assert.ok(error);
		assert.equal(error!.fileOperationResult, FileOperationResult.FILE_TOO_LARGE);
	});

	test('createFile', async () => {
		let event: FileOperationEvent;
		disposables.push(service.onAfterOperation(e => event = e));

		const contents = 'Hello World';
		const resource = URI.file(join(testDir, 'test.txt'));
		const fileStat = await service.createFile(resource, VSBuffer.fromString(contents));
		assert.equal(fileStat.name, 'test.txt');
		assert.equal(existsSync(fileStat.resource.fsPath), true);
		assert.equal(readFileSync(fileStat.resource.fsPath), contents);

		assert.ok(event!);
		assert.equal(event!.resource.fsPath, resource.fsPath);
		assert.equal(event!.operation, FileOperation.CREATE);
		assert.equal(event!.target!.resource.fsPath, resource.fsPath);
	});

	test('createFile (does not overwrite by default)', async () => {
		const contents = 'Hello World';
		const resource = URI.file(join(testDir, 'test.txt'));

		writeFileSync(resource.fsPath, ''); // create file

		try {
			await service.createFile(resource, VSBuffer.fromString(contents));
		}
		catch (error) {
			assert.ok(error);
		}
	});

	test('createFile (allows to overwrite existing)', async () => {
		let event: FileOperationEvent;
		disposables.push(service.onAfterOperation(e => event = e));

		const contents = 'Hello World';
		const resource = URI.file(join(testDir, 'test.txt'));

		writeFileSync(resource.fsPath, ''); // create file

		const fileStat = await service.createFile(resource, VSBuffer.fromString(contents), { overwrite: true });
		assert.equal(fileStat.name, 'test.txt');
		assert.equal(existsSync(fileStat.resource.fsPath), true);
		assert.equal(readFileSync(fileStat.resource.fsPath), contents);

		assert.ok(event!);
		assert.equal(event!.resource.fsPath, resource.fsPath);
		assert.equal(event!.operation, FileOperation.CREATE);
		assert.equal(event!.target!.resource.fsPath, resource.fsPath);
	});

	test('writeFile - buffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		const resource = URI.file(join(testDir, 'small.txt'));

		const content = readFileSync(resource.fsPath);
		assert.equal(content, 'Small File');

		const newContent = 'Updates to the small file';
		await service.writeFile(resource, VSBuffer.fromString(newContent));

		assert.equal(readFileSync(resource.fsPath), newContent);
	});

	test('writeFile (large file) - buffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		const resource = URI.file(join(testDir, 'lorem.txt'));

		const content = readFileSync(resource.fsPath);
		const newContent = content.toString() + content.toString();

		const fileStat = await service.writeFile(resource, VSBuffer.fromString(newContent));
		assert.equal(fileStat.name, 'lorem.txt');

		assert.equal(readFileSync(resource.fsPath), newContent);
	});

	test('writeFile - unbuffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);

		const resource = URI.file(join(testDir, 'small.txt'));

		const content = readFileSync(resource.fsPath);
		assert.equal(content, 'Small File');

		const newContent = 'Updates to the small file';
		await service.writeFile(resource, VSBuffer.fromString(newContent));

		assert.equal(readFileSync(resource.fsPath), newContent);
	});

	test('writeFile (large file) - unbuffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);

		const resource = URI.file(join(testDir, 'lorem.txt'));

		const content = readFileSync(resource.fsPath);
		const newContent = content.toString() + content.toString();

		const fileStat = await service.writeFile(resource, VSBuffer.fromString(newContent));
		assert.equal(fileStat.name, 'lorem.txt');

		assert.equal(readFileSync(resource.fsPath), newContent);
	});

	test('writeFile (large file) - multiple parallel writes queue up', async () => {
		const resource = URI.file(join(testDir, 'lorem.txt'));

		const content = readFileSync(resource.fsPath);
		const newContent = content.toString() + content.toString();

		await Promise.all(['0', '00', '000', '0000', '00000'].map(async offset => {
			const fileStat = await service.writeFile(resource, VSBuffer.fromString(offset + newContent));
			assert.equal(fileStat.name, 'lorem.txt');
		}));

		const fileContent = readFileSync(resource.fsPath).toString();
		assert.ok(['0', '00', '000', '0000', '00000'].some(offset => fileContent === offset + newContent));
	});

	test('writeFile (readable) - buffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		const resource = URI.file(join(testDir, 'small.txt'));

		const content = readFileSync(resource.fsPath);
		assert.equal(content, 'Small File');

		const newContent = 'Updates to the small file';
		await service.writeFile(resource, toLineByLineReadable(newContent));

		assert.equal(readFileSync(resource.fsPath), newContent);
	});

	test('writeFile (large file - readable) - buffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileOpenReadWriteClose);

		const resource = URI.file(join(testDir, 'lorem.txt'));

		const content = readFileSync(resource.fsPath);
		const newContent = content.toString() + content.toString();

		const fileStat = await service.writeFile(resource, toLineByLineReadable(newContent));
		assert.equal(fileStat.name, 'lorem.txt');

		assert.equal(readFileSync(resource.fsPath), newContent);
	});

	test('writeFile (readable) - unbuffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);

		const resource = URI.file(join(testDir, 'small.txt'));

		const content = readFileSync(resource.fsPath);
		assert.equal(content, 'Small File');

		const newContent = 'Updates to the small file';
		await service.writeFile(resource, toLineByLineReadable(newContent));

		assert.equal(readFileSync(resource.fsPath), newContent);
	});

	test('writeFile (large file - readable) - unbuffered', async () => {
		setCapabilities(fileProvider, FileSystemProviderCapabilities.FileReadWrite);

		const resource = URI.file(join(testDir, 'lorem.txt'));

		const content = readFileSync(resource.fsPath);
		const newContent = content.toString() + content.toString();

		const fileStat = await service.writeFile(resource, toLineByLineReadable(newContent));
		assert.equal(fileStat.name, 'lorem.txt');

		assert.equal(readFileSync(resource.fsPath), newContent);
	});

	test('writeFile (file is created including parents)', async () => {
		const resource = URI.file(join(testDir, 'other', 'newfile.txt'));

		const content = 'File is created including parent';
		const fileStat = await service.writeFile(resource, VSBuffer.fromString(content));
		assert.equal(fileStat.name, 'newfile.txt');

		assert.equal(readFileSync(resource.fsPath), content);
	});

	test('writeFile (error when folder is encountered)', async () => {
		const resource = URI.file(testDir);

		let error: Error | undefined = undefined;
		try {
			await service.writeFile(resource, VSBuffer.fromString('File is created including parent'));
		} catch (err) {
			error = err;
		}

		assert.ok(error);
	});

	test('writeFile (no error when providing up to date etag)', async () => {
		const resource = URI.file(join(testDir, 'small.txt'));

		const stat = await service.resolve(resource);

		const content = readFileSync(resource.fsPath);
		assert.equal(content, 'Small File');

		const newContent = 'Updates to the small file';
		await service.writeFile(resource, VSBuffer.fromString(newContent), { etag: stat.etag, mtime: stat.mtime });

		assert.equal(readFileSync(resource.fsPath), newContent);
	});

	test('writeFile (error when writing to file that has been updated meanwhile)', async () => {
		const resource = URI.file(join(testDir, 'small.txt'));

		const stat = await service.resolve(resource);

		const content = readFileSync(resource.fsPath);
		assert.equal(content, 'Small File');

		const newContent = 'Updates to the small file';
		await service.writeFile(resource, VSBuffer.fromString(newContent), { etag: stat.etag, mtime: stat.mtime });

		let error: FileOperationError | undefined = undefined;
		try {
			await service.writeFile(resource, VSBuffer.fromString(newContent), { etag: etag(0, 0), mtime: 0 });
		} catch (err) {
			error = err;
		}

		assert.ok(error);
		assert.ok(error instanceof FileOperationError);
		assert.equal(error!.fileOperationResult, FileOperationResult.FILE_MODIFIED_SINCE);
	});

	test('watch - file', done => {
		const toWatch = URI.file(join(testDir, 'index-watch1.html'));
		writeFileSync(toWatch.fsPath, 'Init');

		assertWatch(toWatch, [[FileChangeType.UPDATED, toWatch]], done);

		setTimeout(() => writeFileSync(toWatch.fsPath, 'Changes'), 50);
	});

	test('watch - file symbolic link', async done => {
		if (isWindows) {
			return done(); // not happy
		}

		const toWatch = URI.file(join(testDir, 'lorem.txt-linked'));
		await symlink(join(testDir, 'lorem.txt'), toWatch.fsPath);

		assertWatch(toWatch, [[FileChangeType.UPDATED, toWatch]], done);

		setTimeout(() => writeFileSync(toWatch.fsPath, 'Changes'), 50);
	});

	test('watch - file - multiple writes', done => {
		if (isWindows) {
			return done(); // not happy
		}

		const toWatch = URI.file(join(testDir, 'index-watch1.html'));
		writeFileSync(toWatch.fsPath, 'Init');

		assertWatch(toWatch, [[FileChangeType.UPDATED, toWatch]], done);

		setTimeout(() => writeFileSync(toWatch.fsPath, 'Changes 1'), 0);
		setTimeout(() => writeFileSync(toWatch.fsPath, 'Changes 2'), 10);
		setTimeout(() => writeFileSync(toWatch.fsPath, 'Changes 3'), 20);
	});

	test('watch - file - delete file', done => {
		const toWatch = URI.file(join(testDir, 'index-watch1.html'));
		writeFileSync(toWatch.fsPath, 'Init');

		assertWatch(toWatch, [[FileChangeType.DELETED, toWatch]], done);

		setTimeout(() => unlinkSync(toWatch.fsPath), 50);
	});

	test('watch - file - rename file', done => {
		const toWatch = URI.file(join(testDir, 'index-watch1.html'));
		const toWatchRenamed = URI.file(join(testDir, 'index-watch1-renamed.html'));
		writeFileSync(toWatch.fsPath, 'Init');

		assertWatch(toWatch, [[FileChangeType.DELETED, toWatch]], done);

		setTimeout(() => renameSync(toWatch.fsPath, toWatchRenamed.fsPath), 50);
	});

	test('watch - file - rename file (different case)', done => {
		const toWatch = URI.file(join(testDir, 'index-watch1.html'));
		const toWatchRenamed = URI.file(join(testDir, 'INDEX-watch1.html'));
		writeFileSync(toWatch.fsPath, 'Init');

		if (isLinux) {
			assertWatch(toWatch, [[FileChangeType.DELETED, toWatch]], done);
		} else {
			assertWatch(toWatch, [[FileChangeType.UPDATED, toWatch]], done); // case insensitive file system treat this as change
		}

		setTimeout(() => renameSync(toWatch.fsPath, toWatchRenamed.fsPath), 50);
	});

	test('watch - file (atomic save)', function (done) {
		const toWatch = URI.file(join(testDir, 'index-watch2.html'));
		writeFileSync(toWatch.fsPath, 'Init');

		assertWatch(toWatch, [[FileChangeType.UPDATED, toWatch]], done);

		setTimeout(() => {
			// Simulate atomic save by deleting the file, creating it under different name
			// and then replacing the previously deleted file with those contents
			const renamed = `${toWatch.fsPath}.bak`;
			unlinkSync(toWatch.fsPath);
			writeFileSync(renamed, 'Changes');
			renameSync(renamed, toWatch.fsPath);
		}, 50);
	});

	test('watch - folder (non recursive) - change file', done => {
		const watchDir = URI.file(join(testDir, 'watch3'));
		mkdirSync(watchDir.fsPath);

		const file = URI.file(join(watchDir.fsPath, 'index.html'));
		writeFileSync(file.fsPath, 'Init');

		assertWatch(watchDir, [[FileChangeType.UPDATED, file]], done);

		setTimeout(() => writeFileSync(file.fsPath, 'Changes'), 50);
	});

	test('watch - folder (non recursive) - add file', done => {
		const watchDir = URI.file(join(testDir, 'watch4'));
		mkdirSync(watchDir.fsPath);

		const file = URI.file(join(watchDir.fsPath, 'index.html'));

		assertWatch(watchDir, [[FileChangeType.ADDED, file]], done);

		setTimeout(() => writeFileSync(file.fsPath, 'Changes'), 50);
	});

	test('watch - folder (non recursive) - delete file', done => {
		const watchDir = URI.file(join(testDir, 'watch5'));
		mkdirSync(watchDir.fsPath);

		const file = URI.file(join(watchDir.fsPath, 'index.html'));
		writeFileSync(file.fsPath, 'Init');

		assertWatch(watchDir, [[FileChangeType.DELETED, file]], done);

		setTimeout(() => unlinkSync(file.fsPath), 50);
	});

	test('watch - folder (non recursive) - add folder', done => {
		const watchDir = URI.file(join(testDir, 'watch6'));
		mkdirSync(watchDir.fsPath);

		const folder = URI.file(join(watchDir.fsPath, 'folder'));

		assertWatch(watchDir, [[FileChangeType.ADDED, folder]], done);

		setTimeout(() => mkdirSync(folder.fsPath), 50);
	});

	test.skip('watch - folder (non recursive) - delete folder', done => {
		const watchDir = URI.file(join(testDir, 'watch7'));
		mkdirSync(watchDir.fsPath);

		const folder = URI.file(join(watchDir.fsPath, 'folder'));
		mkdirSync(folder.fsPath);

		assertWatch(watchDir, [[FileChangeType.DELETED, folder]], done);

		setTimeout(() => rimrafSync(folder.fsPath), 50);
	});

	test('watch - folder (non recursive) - symbolic link - change file', async done => {
		if (isWindows) {
			return done(); // not happy
		}

		const watchDir = URI.file(join(testDir, 'deep-link'));
		await symlink(join(testDir, 'deep'), watchDir.fsPath);

		const file = URI.file(join(watchDir.fsPath, 'index.html'));
		writeFileSync(file.fsPath, 'Init');

		assertWatch(watchDir, [[FileChangeType.UPDATED, file]], done);

		setTimeout(() => writeFileSync(file.fsPath, 'Changes'), 50);
	});

	test('watch - folder (non recursive) - rename file', done => {
		if (!isLinux) {
			return done(); // not happy
		}

		const watchDir = URI.file(join(testDir, 'watch8'));
		mkdirSync(watchDir.fsPath);

		const file = URI.file(join(watchDir.fsPath, 'index.html'));
		writeFileSync(file.fsPath, 'Init');

		const fileRenamed = URI.file(join(watchDir.fsPath, 'index-renamed.html'));

		assertWatch(watchDir, [[FileChangeType.DELETED, file], [FileChangeType.ADDED, fileRenamed]], done);

		setTimeout(() => renameSync(file.fsPath, fileRenamed.fsPath), 50);
	});

	test('watch - folder (non recursive) - rename file (different case)', done => {
		if (!isLinux) {
			return done(); // not happy
		}

		const watchDir = URI.file(join(testDir, 'watch8'));
		mkdirSync(watchDir.fsPath);

		const file = URI.file(join(watchDir.fsPath, 'index.html'));
		writeFileSync(file.fsPath, 'Init');

		const fileRenamed = URI.file(join(watchDir.fsPath, 'INDEX.html'));

		assertWatch(watchDir, [[FileChangeType.DELETED, file], [FileChangeType.ADDED, fileRenamed]], done);

		setTimeout(() => renameSync(file.fsPath, fileRenamed.fsPath), 50);
	});

	function assertWatch(toWatch: URI, expected: [FileChangeType, URI][], done: MochaDone): void {
		const watcherDisposable = service.watch(toWatch);

		function toString(type: FileChangeType): string {
			switch (type) {
				case FileChangeType.ADDED: return 'added';
				case FileChangeType.DELETED: return 'deleted';
				case FileChangeType.UPDATED: return 'updated';
			}
		}

		function printEvents(event: FileChangesEvent): string {
			return event.changes.map(change => `Change: type ${toString(change.type)} path ${change.resource.toString()}`).join('\n');
		}

		const listenerDisposable = service.onFileChanges(event => {
			watcherDisposable.dispose();
			listenerDisposable.dispose();

			try {
				assert.equal(event.changes.length, expected.length, `Expected ${expected.length} events, but got ${event.changes.length}. Details (${printEvents(event)})`);

				if (expected.length === 1) {
					assert.equal(event.changes[0].type, expected[0][0], `Expected ${toString(expected[0][0])} but got ${toString(event.changes[0].type)}. Details (${printEvents(event)})`);
					assert.equal(event.changes[0].resource.fsPath, expected[0][1].fsPath);
				} else {
					for (const expect of expected) {
						assert.equal(hasChange(event.changes, expect[0], expect[1]), true, `Unable to find ${toString(expect[0])} for ${expect[1].fsPath}. Details (${printEvents(event)})`);
					}
				}

				done();
			} catch (error) {
				done(error);
			}
		});
	}

	function hasChange(changes: IFileChange[], type: FileChangeType, resource: URI): boolean {
		return changes.some(change => change.type === type && isEqual(change.resource, resource));
	}
});