import { getDb } from '$lib/db';
import { ProbabilityCalculator, HistoricalOffer } from './probabilityCalculator';

// Interfaces
export interface MarkupResult {
    suggestedMarkup: number;      // Valore del markup suggerito
    probability: number;          // Probabilità di successo con questo markup
    historyCount: number;         // Numero di dati storici utilizzati 
    markupFactors: MarkupFactors; // Dettaglio dei fattori che hanno contribuito al markup
}

export interface MarkupFactors {
    baseMarkup: number;              // Il markup standard applicato a questo tipo di prodotto
    clientHistory?: number;          // Aggiustamento basato sulla storia del cliente
    competitiveAdjustment?: number;  // Aggiustamento basato sulle condizioni di mercato
    volumeDiscount?: number;         // Sconto basato sulla quantità
    urgencyFactor?: number;          // Aggiustamento basato sul timeframe di consegna
}

// Constants
const DEFAULT_MARKUP = 20;
const MIN_MARKUP = 1;
const MAX_MARKUP = 1000;
const DEFAULT_AVG_QUANTITY = 10;

export const SuggestedMarkupRepository = {
    /**
     * Calcola il markup suggerito per un singolo prodotto per un cliente specifico
     * @param customerNr Il numero del cliente
     * @param productId L'ID del prodotto
     * @param quantity La quantità del prodotto
     * @param purchasePrice Il prezzo di acquisto
     * @param rate Il tasso di cambio
     * @returns Markup suggerito e fattori correlati
     */
    async calculateSuggestedMarkup(
        customerNr: string, 
        productId: string, 
        quantity: number = 1,
        purchasePrice: number = 0,
        rate: number = 1
    ): Promise<MarkupResult> {
        const db = await getDb();
        
        try {
            // Inizializza le variabili per il calcolo del markup
            let markup = DEFAULT_MARKUP;
            let markupFactors: MarkupFactors = {
                baseMarkup: DEFAULT_MARKUP
            };
            
            // Recupera lo storico cliente-prodotto
            const history = await this._fetchProductCustomerHistorySuccess(db, customerNr, productId);
            let historyCount = 0;
            let probability = 50; // Probabilità di base
            
            if (history.length > 0) {
                // Abbiamo dati diretti per questo cliente e prodotto
                historyCount = history.length;
                markup = this._computeWeightedMarkup(history);
                markupFactors.baseMarkup = markup;
                
                // Calcola l'aggiustamento della storia del cliente
                const clientAdjustment = await this._calculateClientHistoryAdjustment(db, customerNr);
                if (clientAdjustment !== 0) {
                    markupFactors.clientHistory = clientAdjustment;
                    markup += clientAdjustment;
                }
                
                // Calcola lo sconto per volume
                const volumeDisc = this._calculateVolumeDiscount(quantity, history);
                if (volumeDisc !== 0) {
                    markupFactors.volumeDiscount = volumeDisc;
                    markup += volumeDisc;
                }
                
                // Calcola la probabilità di successo con questo markup
                probability = await ProbabilityCalculator._calculateSuccessProbability(
                    db, markup, productId, customerNr, quantity, purchasePrice, rate);
            } else {             
                // Controlla prodotto con altri clienti
                const generalProductHistory = await this._fetchGeneralProductHistorySuccess(db, productId);
                // Controlla cliente con altri prodotti
                const generalCustomerHistory = await this._fetchGeneralCustomerHistorySuccess(db, customerNr);
                
                // Determina la quantità di storia disponibile
                historyCount = generalProductHistory.length + generalCustomerHistory.length;
                
                // Calcola il markup di fallback
                markup = this._combineFallbackHistories(generalProductHistory, generalCustomerHistory, quantity, productId);
                markupFactors.baseMarkup = markup;
                
                // Aggiusta per il volume se c'è abbastanza storia
                if (historyCount > 0) {
                    const volumeDisc = this._calculateVolumeDiscount(
                        quantity, 
                        [...generalProductHistory, ...generalCustomerHistory]
                    );
                    if (volumeDisc !== 0) {
                        markupFactors.volumeDiscount = volumeDisc;
                        markup += volumeDisc;
                    }
                }
                
                // Probabilità di successo per fallback (meno affidabile)
                probability = await ProbabilityCalculator._calculateFallbackProbability(
                    db, markup, productId, customerNr);
            }
            
            // Limita il markup suggerito al range accettabile
            const finalMarkup = Math.max(MIN_MARKUP, Math.min(MAX_MARKUP, markup));
            
            return {
                suggestedMarkup: Number(finalMarkup.toFixed(1)),
                probability: Math.round(probability),
                historyCount,
                markupFactors
            };
        } catch (error) {
            console.error('Error calculating suggested markup:', error);
            // Valori di default in caso di errore
            return {
                suggestedMarkup: DEFAULT_MARKUP,
                probability: 50,
                historyCount: 0,
                markupFactors: {
                    baseMarkup: DEFAULT_MARKUP
                }
            };
        }
    },
    
    // Metodi di supporto per il calcolo del markup
    
    async _calculateClientHistoryAdjustment(db: any, customerNr: string): Promise<number> {
        // Prima ottieni tutte le offerte per avere il numero totale
        const allHistory = await this._fetchCompleteCustomerHistory(db, customerNr);
        if (allHistory.length === 0) return 0;
        
        // Calcola il tasso di successo direttamente dall'array completo
        const successCount = allHistory.filter(h => h.success === 1).length;
        const successRate = successCount / allHistory.length;
        
        // Aggiusta in base al tasso di successo
        if (successRate > 0.7) {
            // Maggiore è il tasso di successo, maggiore è l'aggiustamento positivo
            const adjustment = Math.min(5, Math.round(successRate * 5));
            return adjustment; // Fino a +5% per clienti ottimi
        }
        
        if (successRate < 0.3 && allHistory.length > 3) {
            // Solo se abbiamo abbastanza dati storici applichiamo un aggiustamento negativo
            return -2;
        }
        
        return 0; // Nessun aggiustamento per tassi medi
    },

    _calculateVolumeDiscount(quantity: number, history: HistoricalOffer[]): number {
        if (history.length === 0) return 0;

        const avgQuantity = history.reduce((sum, h) => sum + (h.offer_answer__qty || 0), 0) / history.length;
        
        // Applica sconti per quantità più grandi
        if (quantity > avgQuantity * 2) return -5;
        if (quantity > avgQuantity * 1.5) return -3;
        if (quantity < avgQuantity * 0.5) return 2;
        return 0;
    },
    
    _computeWeightedMarkup(history: HistoricalOffer[]): number {
        // Filtra per markup validi e ordina per markup
        const validMarkups = history
            .filter(h => h.markup != null && !isNaN(h.markup))
            .map(h => h.markup)
            .sort((a, b) => a - b);

        if (validMarkups.length === 0) return DEFAULT_MARKUP;
        
        // Approccio pragmatico e diretto:
        // Usa il markup più alto tra la mediana e la media dei markup, 
        // questo evita sottovalutazioni e considera i valori di successo
        const medianIndex = Math.floor(validMarkups.length / 2);
        const medianMarkup = validMarkups[medianIndex];
        
        // Calcola anche la media ponderata per completezza (dà più peso ai valori alti)
        const sum = validMarkups.reduce((acc, val) => acc + val, 0);
        const averageMarkup = sum / validMarkups.length;
        
        // Prendi il più alto tra media e mediana, evitando la sottostima
        // Aggiungi un piccolo margine (2%) per ottimizzare il valore proposto
        return Math.max(medianMarkup, averageMarkup) + 2;
    },
    
    _combineFallbackHistories(productHistory: HistoricalOffer[], customerHistory: HistoricalOffer[], currentQty: number, productId: string = ''): number {
        const productMarkup = productHistory.length > 0 ? this._computeWeightedMarkup(productHistory) : DEFAULT_MARKUP;
        const customerMarkup = customerHistory.length > 0 ? this._computeWeightedMarkup(customerHistory) : DEFAULT_MARKUP;

        const weightProduct = productHistory.length > 0 ? 0.7 : 0;
        const weightCustomer = customerHistory.length > 0 ? 0.3 : 0;
        const totalWeight = weightProduct + weightCustomer;

        let baseMarkup;
        
        if (totalWeight > 0) {
            baseMarkup = ((productMarkup * weightProduct) + (customerMarkup * weightCustomer)) / totalWeight;
        } else {
            // No history available, create a varied base markup using product ID
            if (productId) {
                // Use product ID to create deterministic but varied markup
                const productIdSum = productId.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
                
                // Generate a variation between -7 and +12 based on product ID
                const variation = (productIdSum % 20) - 7;
                
                // Category-based adjustments (using the last 2 digits of product ID as proxy)
                const lastTwoDigits = parseInt(productId.slice(-2)) || 0;
                let categoryAdjustment = 0;
                
                if (lastTwoDigits < 20) {
                    // Low-end category: lower markup
                    categoryAdjustment = -3;
                } else if (lastTwoDigits > 80) {
                    // High-end category: higher markup
                    categoryAdjustment = 5;
                }
                
                baseMarkup = DEFAULT_MARKUP + variation + categoryAdjustment;
                
                // Ensure within reasonable bounds
                baseMarkup = Math.max(MIN_MARKUP + 2, Math.min(MAX_MARKUP - 5, baseMarkup));
                
            } else {
                baseMarkup = DEFAULT_MARKUP;
            }
        }

        // Usiamo lo storico combinato per l'aggiustamento
        const combinedHistory = [...productHistory, ...customerHistory];
        return this._adjustForQuantity(currentQty, combinedHistory, baseMarkup);
    },
    
    _adjustForQuantity(currentQty: number, history: HistoricalOffer[], baseMarkup: number): number {
        const avgHistoricalQty = history.length > 0 
            ? history.reduce((sum, h) => sum + (h.offer_answer__qty || 1), 0) / history.length 
            : DEFAULT_AVG_QUANTITY;
        const qtyRatio = currentQty / avgHistoricalQty;

        if (qtyRatio > 2) {
            return baseMarkup * 0.9;
        }
        if (qtyRatio < 0.5) {
            return baseMarkup * 1.1;
        }
        return baseMarkup;
    },
    
    // Database query methods
    async _fetchProductCustomerHistorySuccess(db: any, customerNr: string, productId: string): Promise<HistoricalOffer[]> {
        return db.prepare(`
            SELECT 
                offer_answer__box_price_chf,
                purchase_price__gross_purchase_price,
                rate,
                offer_answer__qty,
                offer__encoding_date,
                calculated_markup_percentage as markup
            FROM offers
            WHERE customer__nr = ?
            AND product__id = ?
            AND offer__success = 1
            ORDER BY offer__encoding_date DESC
            LIMIT 10
        `).all([customerNr, productId]);
    },

    async _fetchCompleteProductCustomerHistory(db: any, customerNr: string, productId: string): Promise<HistoricalOffer[]> {
        return db.prepare(`
            SELECT 
                offer__success as success,
                offer__nr,
                product__id,
                offer_answer__box_price_chf,
                purchase_price__gross_purchase_price,
                rate,
                offer_answer__qty,
                offer__encoding_date,
                calculated_markup_percentage as markup
            FROM offers
            WHERE customer__nr = ?
            AND product__id = ?
            ORDER BY offer__encoding_date DESC
            LIMIT 20
        `).all([customerNr, productId]);
    },

    async _fetchGeneralProductHistorySuccess(db: any, productId: string): Promise<HistoricalOffer[]> {
        return db.prepare(`
            SELECT 
                offer_answer__box_price_chf,
                purchase_price__gross_purchase_price,
                rate,
                offer_answer__qty,
                calculated_markup_percentage as markup
            FROM offers
            WHERE product__id = ?
            AND offer__success = 1
            ORDER BY offer__encoding_date DESC
            LIMIT 20
        `).all([productId]);
    },

    async _fetchCompleteProductHistory(db: any, productId: string): Promise<HistoricalOffer[]> {
        return db.prepare(`
            SELECT 
                offer__success as success,
                offer__nr,
                product__id,
                offer_answer__box_price_chf,
                purchase_price__gross_purchase_price,
                rate,
                offer_answer__qty,
                offer__encoding_date,
                calculated_markup_percentage as markup
            FROM offers
            WHERE product__id = ?
            ORDER BY offer__encoding_date DESC
            LIMIT 30
        `).all([productId]);
    },

    async _fetchGeneralCustomerHistorySuccess(db: any, customerNr: string): Promise<HistoricalOffer[]> {
        return db.prepare(`
            SELECT 
                calculated_markup_percentage as markup
            FROM offers
            WHERE customer__nr = ?
            AND offer__success = 1
            ORDER BY offer__encoding_date DESC
            LIMIT 20
        `).all([customerNr]);
    },

    async _fetchCompleteCustomerHistory(db: any, customerNr: string): Promise<HistoricalOffer[]> {
        return db.prepare(`
            SELECT 
                offer__success as success,
                offer__nr,
                offer_answer__box_price_chf,
                purchase_price__gross_purchase_price,
                rate,
                offer_answer__qty,
                offer__encoding_date,
                ((offer_answer__box_price_chf - (purchase_price__gross_purchase_price * rate)) / 
                 (purchase_price__gross_purchase_price * rate) * 100) as markup
            FROM offers
            WHERE customer__nr = ?
            ORDER BY offer__encoding_date DESC
            LIMIT 30
        `).all([customerNr]);
    }
};
