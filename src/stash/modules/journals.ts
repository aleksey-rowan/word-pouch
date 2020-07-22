import { db, Group, Journal } from '@/api/db';
import { reduceArrayToObject } from '@/util';
import Dexie from 'dexie';
import { EntrySet, Stash, DBEntryStashModule, StashModuleState } from '../internal';

export type JournalSet = EntrySet<Journal>;

export class JournalsState extends StashModuleState<Journal> {
    activeId: number | null = null;
}

export class JournalsModule extends DBEntryStashModule<Journal, JournalsState> {
    constructor(stash: Stash) {
        super(stash, db.journals, JournalsState);
    }

    get activeId(): number | null {
        return this.state.activeId;
    }

    get active(): Journal | null {
        return this.all[this.activeId ?? -1] || null;
    }

    /**
     * Fetch journals from the db.
     *
     * @returns {Promise<void>}
     */
    async fetch(): Promise<void> {
        this.reset(); // remove any previously loaded journals

        const journals = await this.table.toArray();

        this.state.all = reduceArrayToObject(journals);
    }

    /**
     * Create a new Journal with the name provided, and add it to the state and db.
     * Returns the id of the new journal.
     *
     * @param {string} [name='Default Journal']
     * @returns {Promise<number>}
     * @memberof JournalsModule
     */
    async new(name = 'Default Journal'): Promise<number> {
        return db.transaction('rw', this.table, db.groups, async () => {
            // create and get a new journal
            const newJournalId = await this.table.add(new Journal(name));
            const newJournal = await this.table.get(newJournalId);
            if (!newJournal) {
                Dexie.currentTransaction.abort();
                throw new Error('journals/new: Cannot create a new journal.');
            }

            // create a Root Group directly from here as it's done only during the initial set up and cannot be changed later
            const rootGroupId = await db.groups.add(new Group('Root group', newJournal.id));

            // add the newly created journal directly to the state
            // since it's a new journal and it's already in DB and it's not active yet this will not trigger any further fetching from the db
            this.addToState(newJournal);

            // set rootGroupId of the new Journal;
            // rootGroupId cannot be changed after a journal is created
            await this.updateStateAndDb(newJournal.id, 'rootGroupId', rootGroupId);

            return newJournal.id;
        });
    }

    /**
     * Delete a specified journal from the database along with all related journal records (groups, words, sources, etc.).
     *
     *
     * @param {number} id
     * @returns {Promise<void>}
     * @memberof JournalsModule
     */
    async delete(journalId: number): Promise<void> {
        if (!this.isValid(journalId)) throw new Error(`${this.moduleName}/delete: Journal #${journalId} is not valid.`);

        // when deleting an active journal, set active id to `null`
        if (journalId === this.activeId) {
            this.reset();
        }

        await db.transaction('rw', this.table, db.groups, db.words, db.wordsInGroups, async () => {
            const groupIds = await db.groups.where({ journalId }).primaryKeys();

            await db.groups.where({ journalId }).delete();
            await db.words.where({ journalId }).delete();
            await db.wordsInGroups
                .where('groupId')
                .anyOf(groupIds)
                .delete();

            await this.table.delete(journalId);
            this.deleteFromState(journalId);

            // TODO: purge sample sources
        });
    }

    /**
     * Set a specified journal as active. This will load all groups belonging to this journal.
     *
     * @param {(number | null)} [value=null]
     * @returns {Promise<void>}
     * @memberof JournalsModule
     */
    async setActiveId(value: number | null = null): Promise<void> {
        this.state.activeId = value;

        if (value) {
            await this.$stash.groups.fetchJournalGroups();
        } else {
            this.$stash.groups.reset();
            this.$stash.words.reset();
            // TODO: reset sources
        }
    }

    /**
     * Set name of the specified Journal.
     * Returns 0 if the operation doesn't succeed.
     *
     * @param {number} journalId
     * @param {string} name
     * @returns {Promise<number>}
     * @memberof JournalsModule
     */
    async setName(journalId: number, name: string): Promise<number> {
        if (!this.isValid(journalId))
            throw new Error(`${this.moduleName}/setName: Journal #${journalId} is not valid.`);

        return this.updateStateAndDb(journalId, 'name', name);
    }

    /**
     * Set the defaultGroupId of the active Journal.
     *
     * @param {(number | null)} defaultGroupId
     * @returns {Promise<void>}
     * @memberof JournalsModule
     */
    async setDefaultGroupId(defaultGroupId: number | null): Promise<void> {
        if (!this.activeId) throw new Error(`${this.moduleName}/setDefaultGroupId: Active journal is not set.`);

        // check if the `defaultGroupId` is a valid group id and is not the root group id
        if (
            defaultGroupId &&
            (!this.$stash.groups.isValid(defaultGroupId) || defaultGroupId === this.active?.rootGroupId)
        )
            throw new Error(`${this.moduleName}/setDefaultGroupId: Group id #${defaultGroupId} is not valid.`);

        await this.updateStateAndDb(this.activeId, 'defaultGroupId', defaultGroupId);
    }

    /**
     * Reset the Journal, Groups, and Words states to their defaults.
     *
     * @memberof JournalsModule
     */
    reset(): void {
        super.reset();

        this.$stash.groups.reset();
        this.$stash.words.reset();
    }
}
