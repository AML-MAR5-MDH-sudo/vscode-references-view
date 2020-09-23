/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { WordAnchor } from './history';
import { ContextKey } from './models';

interface ActiveTreeDataProviderWrapper {
	provider: Promise<Required<vscode.TreeDataProvider<any>>>;
}

class TreeDataProviderDelegate implements vscode.TreeDataProvider<undefined> {

	provider?: Promise<Required<vscode.TreeDataProvider<any>>>;

	private _sessionDispoables?: vscode.Disposable;
	private _onDidChange = new vscode.EventEmitter<any>();

	readonly onDidChangeTreeData = this._onDidChange.event;

	update(provider: Promise<Required<vscode.TreeDataProvider<any>>>) {

		this._sessionDispoables?.dispose();
		this._sessionDispoables = undefined;

		this._onDidChange.fire();

		this.provider = provider;

		provider.then(value => {
			if (this.provider === provider) {
				this._sessionDispoables = value.onDidChangeTreeData(this._onDidChange.fire, this._onDidChange);
			}
		}).catch(err => {
			this.provider = undefined;
			console.error(err);
		});
	}

	async getTreeItem(element: unknown) {
		this._assertProvider();
		return (await this.provider).getTreeItem(element);
	}

	async getChildren(parent?: unknown | undefined) {
		this._assertProvider();
		return (await this.provider).getChildren(parent);
	}

	async getParent(element: unknown) {
		this._assertProvider();
		return (await this.provider).getParent(element);
	}

	private _assertProvider(): asserts this is ActiveTreeDataProviderWrapper {
		if (!this.provider) {
			throw new Error('MISSING provider');
		}
	}
}

export interface SymbolItemNavigation<T> {
	nearest(uri: vscode.Uri, position: vscode.Position): T | undefined;
	next(from: T): T;
	previous(from: T): T;
}

export interface SymbolItemHighlights<T> {
	getEditorHighlights(item: T, uri: vscode.Uri): vscode.Range[] | undefined;
}

export interface SymbolTreeModel {
	message: string | undefined,
	provider: Required<vscode.TreeDataProvider<unknown>>;
	navigation?: SymbolItemNavigation<any>;
	highlights?: SymbolItemHighlights<any>;
}

export interface SymbolTreeInput {
	title: string;
	uri: vscode.Uri;
	position: vscode.Position;
	resolve(): Promise<SymbolTreeModel>;
	hash(): string;
}

export class SymbolsTree {

	readonly viewId = 'references-view.tree';

	private readonly _onDidChangeInput = new vscode.EventEmitter<this>();
	readonly onDidChangeInput = this._onDidChangeInput.event;

	private readonly _ctxIsActive = new ContextKey<boolean>('reference-list.isActive');
	private readonly _ctxHasResult = new ContextKey<boolean>('reference-list.hasResult');

	private readonly _history = new TreeInputHistory(this);
	private readonly _provider = new TreeDataProviderDelegate();
	private readonly _tree: vscode.TreeView<unknown>;

	private _input?: SymbolTreeInput;
	private _sessionDisposable?: vscode.Disposable;

	constructor() {
		this._tree = vscode.window.createTreeView<unknown>(this.viewId, {
			treeDataProvider: this._provider,
			showCollapseAll: true
		});
	}

	dispose(): void {
		this._tree.dispose();
		this._onDidChangeInput.dispose();
	}

	getInput(): SymbolTreeInput | undefined {
		return this._input;
	}

	setInput(input: SymbolTreeInput) {

		this._history.add(input);
		this._ctxIsActive.set(true);
		this._ctxHasResult.set(true);
		vscode.commands.executeCommand(`${this.viewId}.focus`);

		this._input = input;
		this._sessionDisposable?.dispose();

		this._tree.title = input.title;
		this._tree.message = undefined;

		const model = input.resolve();

		this._provider.update(model.then(model => model.provider));

		model.then(model => {

			if (this._input !== input) {
				return;
			}

			this._tree.title = input.title;
			this._tree.message = model.message;

			// reveal & select
			const selection = model.navigation?.nearest(input.uri, input.position);
			if (selection && this._tree.visible) {
				this._tree.reveal(selection, { select: true, focus: true, expand: true });
			}

			const listener: vscode.Disposable[] = [];

			listener.push(model.provider.onDidChangeTreeData(() => {
				this._tree.title = input.title;
				this._tree.message = model.message;
			}));

			if (typeof ((model.provider as unknown) as vscode.Disposable).dispose === 'function') {
				listener.push((model.provider as unknown) as vscode.Disposable);
			}
			this._sessionDisposable = vscode.Disposable.from(...listener);
		});
	}

	clearInput(): void {
		this._input = undefined;
		this._ctxHasResult.set(false);
		this._tree.title = 'References';
		this._tree.message = undefined;
		this._provider.update(Promise.resolve(this._history));
		if (this._history.size === 0) {
			this._tree.message = 'Nothing to show';
		}
	}
}

// --- history

class HistoryItem {
	constructor(
		readonly word: string,
		readonly anchor: WordAnchor,
		readonly input: SymbolTreeInput,
	) { }
}

class TreeInputHistory implements vscode.TreeDataProvider<HistoryItem>{

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<HistoryItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly _ctxHasHistory = new ContextKey<boolean>('reference-list.hasHistory');
	private readonly _inputs = new Map<string, Thenable<HistoryItem>>();

	constructor(tree: SymbolsTree) {

		vscode.commands.registerCommand('references-view.clear', () => tree.clearInput());
		vscode.commands.registerCommand('references-view.clearHistory', () => this.clear());
		vscode.commands.registerCommand('references-view.refind', (item) => {
			if (item instanceof HistoryItem) {
				tree.setInput(item.input);
			}
		});
		vscode.commands.registerCommand('_references-view.showHistoryItem', (item) => {
			if (item instanceof HistoryItem) {
				const position = item.anchor.getPosition() ?? item.input.position;
				return vscode.commands.executeCommand('vscode.open', item.input.uri, { selection: new vscode.Range(position, position) });
			}
		});
	}

	add(input: SymbolTreeInput): void {

		const p = vscode.workspace.openTextDocument(input.uri).then(doc => {
			const anchor = new WordAnchor(doc, input.position);
			const range = doc.getWordRangeAtPosition(input.position) ?? doc.getWordRangeAtPosition(input.position, /[^\s]+/);
			const word = range ? doc.getText(range) : '???';
			return new HistoryItem(word, anchor, input);
		});

		// use filo-ordering of native maps
		const key = input.hash();
		this._inputs.delete(key);
		this._inputs.set(key, p);
		this._ctxHasHistory.set(true);
	}

	clear(): void {
		this._inputs.clear();
		this._ctxHasHistory.set(false);
		this._onDidChangeTreeData.fire(undefined);
	}

	get size() {
		return this._inputs.size;
	}

	// --- tree data provider

	getTreeItem(element: HistoryItem): vscode.TreeItem {
		const result = new vscode.TreeItem(element.word);
		result.description = `${vscode.workspace.asRelativePath(element.input.uri)} • ${element.input.title.toLocaleLowerCase()}`;
		// result.command = { command: 'references-view.SHOW', arguments: [element], title: 'Rerun' };
		result.collapsibleState = vscode.TreeItemCollapsibleState.None;
		result.contextValue = 'history-item';
		return result;
	}

	getChildren() {
		return Promise.all([...this._inputs.values()].reverse());
	}

	getParent() {
		return undefined;
	}
}