/// <reference path="../../../Scripts/extensions.ts" />
/// <reference path="../../../Scripts/typings/knockout.postbox/knockout-postbox.d.ts" />
/// <reference path="../../../Scripts/typings/durandal/durandal.d.ts" />

import widget = require("plugins/widget");
import pagedList = require("common/pagedList");
import raven = require("common/raven");
import appUrl = require("common/appUrl");
import document = require("models/document");
import collection = require("models/collection");
import database = require("models/database");
import pagedResultSet = require("common/pagedResultSet"); 
import deleteDocuments = require("viewmodels/deleteDocuments");
import copyDocuments = require("viewmodels/copyDocuments");
import app = require("durandal/app");

interface cell {
    templateName: string;
    value: any;
}

interface row {
	isChecked: KnockoutObservable<boolean>;
	cells: KnockoutObservableArray<cell>; 
	data: any;
}

// Durandal.js configuration requires that exported widgets be named ctor.
class ctor {

    rows = ko.observableArray();
    columns = ko.observableArray();
	isLoading: KnockoutComputed<boolean>;
    allRowsChecked: KnockoutComputed<boolean>;
    private selectionStack: row[];
	isFirstRender = true;
	skip = 0;
	take = 100;
	totalRowsCount = 0;
    private currentItemsCollection: KnockoutObservable<pagedList>;
    private collections: KnockoutObservableArray<collection>;
    private memoizedColorClassForEntityName: Function;
    private currentDatabase = raven.activeDatabase(); // We deliberately store this as a plain value, rather than observable, for performance reasons: it is evaluated every time we create an ID cell. See createCell(...)
    isContextMenuVisible = ko.observable(false);
    contextMenuX = ko.observable(0);
    contextMenuY = ko.observable(0);
    settings: any;
    subscriptions: Array<KnockoutSubscription> = [];

    constructor() {
    }

    activate(settings: any) {
        this.settings = settings;
        if (!settings.items || !ko.isObservable(settings.items)) {
            throw new Error("datatable must be passed an items observable.");
        }

        this.currentItemsCollection = this.settings.items;
        this.collections = this.settings.collections;
        this.selectionStack = [];
        this.memoizedColorClassForEntityName = this.getColorClassFromEntityName.memoize(this);
        this.fetchNextChunk();

        // Computeds
        this.allRowsChecked = ko.computed({
            read: () => this.rows().length > 0 && this.rows().every(r => r.isChecked()),
            write: (val) => this.rows().forEach(r => r.isChecked(val))
        });
        this.isLoading = ko.computed(() => this.currentItemsCollection() && this.currentItemsCollection().isFetching());

        // Subscriptions
        var currentCollectionSubscription = this.currentItemsCollection.distinctUntilChanged().subscribe(() => {
            this.rows.removeAll();
            this.columns.removeAll();
            this.fetchNextChunk();
            this.selectionStack.length = 0;
        });
        var currentDatabaseSubscription = ko.postbox.subscribe("ActivateDatabase", db => this.currentDatabase = db);
        this.subscriptions.pushAll([currentCollectionSubscription, currentDatabaseSubscription]);

        // Initialization
        if (this.currentItemsCollection()) {
            this.fetchNextChunk();
        }

        // Initialize the context menu (using Bootstrap-ContextMenu library).
        // TypeScript doesn't know about Bootstrap-Context menu, so we cast jQuery as any.
        (<any>$('.datatable tbody')).contextmenu({ 'target': '#documents-grid-context-menu' });
    }

    deactivate() {
        this.subscriptions.forEach(s => s.dispose());
    }
    
    fetchNextChunk() {
		var collection = this.currentItemsCollection();
		if (collection) {
			var nextChunkPromiseOrNull = collection.loadNextChunk();
			if (nextChunkPromiseOrNull) {
				nextChunkPromiseOrNull.done(results => this.nextChunkFetched(results));
			}
		}
    }

    private nextChunkFetched(results: pagedResultSet) {
        this.totalRowsCount = results.totalResultCount;

        this.createCellsForColumns(this.rows(), this.getPropertyNames(results.items));

        var rows: row[] = results.items
            .map((row, rowIndex) => {
                var cells = this
                    .columns()
                    .map(c => this.createCell(this.getTemplateForCell(c, row), c, row, rowIndex, row[c]));

                return this.createRow(row, ko.observableArray(cells));
			});

		this.rows.pushAll(rows);
    }

    getPropertyNames(objects: any[]): string[] {
        var propertyNames: string[] = [];
        objects.forEach(f => {
            for (var property in f) {
                if (f.hasOwnProperty(property) && property !== '__metadata' && propertyNames.indexOf(property) == -1) {
                    propertyNames.push(property);
                }
            }
        });
        return propertyNames;
    }

    private createCellsForColumns(rows: row[], columns: string[]) {

        var newColumns = columns
            .filter(c => this.columns().indexOf(c) === -1 && c !== "Id") // Ignore the Id column, since we pull that from the metadata.
            .sort((a, b) => { 
                // Prefer 'Name' before others.
                if (a === "Name") return -1;
                if (b === "Name") return 1;
                if (a) return a.localeCompare(b);
                if (b) return b.localeCompare(a);
                return 0;
            }); 

        if (this.columns().length === 0) {
            newColumns.unshift("Id");
        }

        if (newColumns.length > 0) {
            var createNewCells = row => newColumns.map(c => this.createCell("default-cell-template", c, row, 0, ""));
            this.columns.pushAll(newColumns);

            rows.forEach(r => r.cells.pushAll(createNewCells(r)));
        }
    }

    private selectOnRightClick(row: row, e: MouseEvent) {
        // Like Gmail, we select on right click.
        var rightMouseButton = 2;
        if (e.button === rightMouseButton) {
            if (!row.isChecked()) {
                row.isChecked(true);
                this.selectionStack.push(row);
            }
        }
	}

    private toggleChecked(row: row, e: any) {
        row.isChecked(!row.isChecked());
        var rowIndex = this.rows.indexOf(row);
        if (row.isChecked()) {
            this.selectionStack.unshift(row);
        } else {
            var indexOfRemovedItem = this.selectionStack.indexOf(row);
            if (indexOfRemovedItem >= 0) {
                this.selectionStack.splice(indexOfRemovedItem, 1);
            }
        }

        // If the shift key was pressed, we want to select/deselect
        // everything between the row and the previous selected row.
        if (e && e.shiftKey && this.selectionStack.length > 1) {
            var newSelectionState = row.isChecked();
            var previousSelectionIndex = this.rows.indexOf(newSelectionState ? this.selectionStack[1] : this.selectionStack[0]);
            var validIndices = rowIndex >= 0 && previousSelectionIndex >= 0 && rowIndex != previousSelectionIndex;
            if (validIndices) {
                var rowsToChange = this.rows.slice(Math.min(rowIndex, previousSelectionIndex), Math.max(rowIndex, previousSelectionIndex));
                rowsToChange.forEach((r: row) => r.isChecked(newSelectionState));
                
                if (newSelectionState === true) {
                    rowsToChange
                        .filter(r => this.selectionStack.indexOf(r) === -1)
                        .forEach(r => this.selectionStack.push(r));
                } else {
                    rowsToChange
                        .filter(r => this.selectionStack.indexOf(r) !== -1)
                        .forEach(r => this.selectionStack.splice(this.selectionStack.indexOf(r), 1));
                }
            }
        }
    }

    getTemplateForCell(columnName: string, row: any) {
        if (columnName == "Id") {
            return "colored-id-cell-template";
        }

        // TODO: better way to do this?
        if (row[columnName]) {
            var matches = row[columnName].toString().match(/\w+\/\d+/);
            var looksLikeId = matches && matches[0] == row[columnName];
            if (looksLikeId) {
                return "id-cell-template";
            }
        }

        return "default-cell-template";
    }

    toggleAllRowsChecked() {
        this.allRowsChecked(!this.allRowsChecked());
    }
    
    onLastRowVisible() {
        var needsMoreRows = this.rows().length < this.totalRowsCount;
        if (needsMoreRows && !this.isLoading()) {
            this.fetchNextChunk();
        }
    }

    copySelectedDocs(idsOnly = false) {
        var docs = this.selectionStack.map<document>(r => r.data);
        if (docs.length > 0) {
            var copyDocsViewModel = new copyDocuments(docs)
            app.showDialog(copyDocsViewModel);
        }
    }

    afterRenderColumn() {
        if (this.isFirstRender) {
            this.isFirstRender = false;
            
            // Setup infinite scrolling via jQuery appear plugin. 
            // Used for determining whether the last row is visible or near visible.
            (<any>$('.document-row:last-child')).appear();
            $(window.document.body).on('appear', '.document-row:last-child', () => this.onLastRowVisible());
        }
    }

    private createRow(rowData: any, cells: KnockoutObservableArray<cell>): row {
        return {
			data: rowData,
            cells: cells,
            isChecked: ko.observable(false)
        }
    }

    private createCell(templateName: string, columnName: string, rowData: document, rowIndex: number, value: any): cell {
        
        // If it's the ID column, and we don't have a value, pull the ID
        // from the document metadata.
        if (columnName === "Id" && !value && rowData && !rowData["Id"] && rowData.__metadata) {
            value = rowData.__metadata.id;
        }

        // If it's an object, give us the JSON string.
        if (value && typeof (value) == "object") {
            value = ko.toJSON(value);
        }

        var cell = {
            colorClass: "",
            templateName: templateName,
            value: value,
            href: undefined
        }

        var isIdColumn = columnName === "Id";
        if (isIdColumn) {
            cell.colorClass = this.memoizedColorClassForEntityName(rowData.__metadata.ravenEntityName);
        }

        // If we've got an ID cell on our hands, try to figure out the href to use.
        var isIdTemplate = templateName === "id-cell-template" || templateName === "colored-id-cell-template";
        if (this.currentDatabase && isIdTemplate) {
            var matches = value.match(/\w+\/\d+/);
            if (matches && matches[0] === value) {
                var idValue = matches[0];
                var collectionName = isIdColumn ? rowData.__metadata.ravenEntityName : raven.getEntityNameFromId(idValue); // If this is the Id column, use the entity name from the metadata. Otherwise, pull the entity name from the ID itself.
                cell.href = appUrl.forEditDoc(idValue, collectionName, rowIndex);
            }
        }

        return cell;
    }

    getColorClassFromEntityName(entityName: string) {
        for (var i = 1; i < this.collections().length; i++) {
            if (this.collections()[i].name === entityName) {
                return this.collections()[i].colorClass;
            }
        }
    }

    onKeyDown(sender, e: KeyboardEvent) {
        var deleteKey = 46;
        if (e.which === deleteKey && this.selectionStack.length > 0) {
            e.stopPropagation();
            this.deleteSelection();
        }
    }

    deleteSelection() {
        if (this.selectionStack.length > 0) {
            var selectedItems = this.selectionStack.map(s => <document>s.data);
            var deleteDocsVm = new deleteDocuments(selectedItems);
            deleteDocsVm.deletionTask.done(deletedDocs => this.onItemsDeleted(deletedDocs));
            app.showDialog(deleteDocsVm);
        }
    }

    editSelection() {
        var lastSelected = this.selectionStack.last();
        if (lastSelected) {
            var docsList = this.currentItemsCollection();
            var currentItemIndex = this.rows.indexOf(lastSelected);
            if (currentItemIndex === -1) {
                currentItemIndex = 0;
            }
            docsList.currentItemIndex(currentItemIndex);
            var args = { doc: lastSelected.data, docsList: docsList };
            ko.postbox.publish("EditDocument", args);
        }
    }

    onItemsDeleted(items: any[]) {
        var deletedRows = this.rows().filter(r => items.indexOf(r.data) >= 0);
        this.rows.removeAll(deletedRows);
        this.selectionStack.removeAll(deletedRows);
    }
}

export = ctor;