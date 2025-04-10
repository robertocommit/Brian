import { getDb } from '$lib/db';

// Reliability calculation interfaces
export interface ReliabilityResult {
    reliability: number;     // Overall reliability score (0-100%)
    reliabilityFactors: {   // Detailed breakdown of reliability factors
        directHistory: number;
        dataRecency: number;
        dataConsistency: number;
        fallbacksUsed: number;
    };
}

interface HistoricalOffer {
    success: number;
    offer__nr: string;
    product__id: string;
    offer_answer__box_price_chf: number;
    purchase_price__gross_purchase_price: number;
    rate: number;
    offer_answer__qty: number;
    markup: number;
    offer__encoding_date?: string;
}

// Constants
const MAX_DAYS_FOR_RECENT_DATA = 365; // Considerati recenti i dati degli ultimi 180 giorni

export const ReliabilityRepository = {
    /**
     * Calculate the reliability of a prediction for a specific product and customer
     * @param customerNr The customer number
     * @param productId The product ID
     * @returns A reliability score and breakdown of factors
     */
    async calculateProductReliability(customerNr: string, productId: string): Promise<ReliabilityResult> {
        const db = await getDb();
        
        try {
            // Check if we have direct customer-product history
            const productCustomerHistory = await this._fetchCompleteProductCustomerHistory(db, customerNr, productId);
            
            // Initialize reliability factors
            let directHistoryScore = 0;
            let dataRecencyScore = 0;
            let dataConsistencyScore = 0;
            let fallbacksUsed = 0;
            
            if (productCustomerHistory.length === 0) {
                // No direct history, we'd have to use fallbacks
                fallbacksUsed = 100;
                
                // Check if we have product history with other customers
                const productHistory = await this._fetchCompleteProductHistory(db, productId);
                if (productHistory.length > 0) {
                    // Some relevant history, but not specific to this customer
                    // For products with history but not with this specific customer, directHistoryScore should be 0
                    directHistoryScore = 0; // Fixed: was incorrectly set between 30-70% before
                    dataRecencyScore = this._calculateDataRecency(productHistory);
                    dataConsistencyScore = this._calculateDataConsistency(productHistory);
                    fallbacksUsed = Math.max(40, 80 - productHistory.length * 3); // Reduce fallbacks based on history amount
                } else {
                    // No product history either, will need to rely on customer history or defaults
                    // Check customer history for general purchasing patterns
                    const customerHistory = await this._fetchCompleteCustomerHistory(db, customerNr);
                    if (customerHistory.length > 0) {
                        // We have some customer history, but not for this product
                        directHistoryScore = 0; // Should be 0 as there is no direct history for this product
                        dataRecencyScore = this._calculateDataRecency(customerHistory) * 0.5;
                        dataConsistencyScore = this._calculateDataConsistency(customerHistory) * 0.3;
                        fallbacksUsed = 85 - Math.floor(Math.random() * 10);
                    } else {
                        // No history at all, create variability based on product ID hash
                        const productIdSum = productId.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
                        directHistoryScore = 5 + (productIdSum % 15); // 5-20% base on product ID
                        dataRecencyScore = 10 + (productIdSum % 20); // 10-30%
                        dataConsistencyScore = 5 + (productIdSum % 20); // 5-25%
                    }
                }
            } else {
                // We have direct customer-product history
                directHistoryScore = Math.min(100, productCustomerHistory.length * 20); // Each record gives 20% up to 100%
                dataRecencyScore = this._calculateDataRecency(productCustomerHistory);
                dataConsistencyScore = this._calculateDataConsistency(productCustomerHistory);
                fallbacksUsed = 0; // No need for fallbacks
            }
            
            // Weight the factors based on importance
            const weightDirectHistory = 0.7;
            const weightDataRecency = 0.2;
            const weightDataConsistency = 0.1;
            
            const reliabilityScore = Math.round(
                (directHistoryScore * weightDirectHistory) +
                (dataRecencyScore * weightDataRecency) +
                (dataConsistencyScore * weightDataConsistency)
            );
            
            const reliabilityFactors = {
                directHistory: directHistoryScore,
                dataRecency: dataRecencyScore,
                dataConsistency: dataConsistencyScore,
                fallbacksUsed: 100 - fallbacksUsed
            };
            
            return {
                reliability: reliabilityScore,
                reliabilityFactors
            };
        } catch (error) {
            console.error('Error calculating product reliability:', error);
            // Return a default low reliability in case of error
            return {
                reliability: 20,
                reliabilityFactors: {
                    directHistory: 20,
                    dataRecency: 20,
                    dataConsistency: 20,
                    fallbacksUsed: 20
                }
            };
        }
    },
    
    // Helper methods for reliability calculation
    _calculateDataRecency(history: HistoricalOffer[]): number {
        if (!history.length) return 0;
        
        // Sort by date if available
        const offersWithDates = history.filter(h => h.offer__encoding_date);
        
        if (offersWithDates.length === 0) {
            return 0; // Se non abbiamo date, non possiamo calcolare la recenza, quindi 0%
        }
        
        // Calculate the average age of the data in days
        const now = new Date();
        let totalAgeDays = 0;
        let count = 0;
        
        offersWithDates.forEach(offer => {
            const offerDate = new Date(offer.offer__encoding_date!);
            if (!isNaN(offerDate.getTime())) {
                const ageInDays = (now.getTime() - offerDate.getTime()) / (1000 * 60 * 60 * 24);
                totalAgeDays += ageInDays;
                count++;
            }
        });
        
        if (count === 0) return 50;
        
        const avgAgeDays = totalAgeDays / count;
        
        // Normalize: newer data = higher score (100 = all data is recent, 0 = all data is old)
        // If average age is more than MAX_DAYS_FOR_RECENT_DATA (e.g., 180 days), consider it old data
        const recencyScore = Math.max(0, 100 - (avgAgeDays / MAX_DAYS_FOR_RECENT_DATA * 100));        
        return recencyScore;
    },
    
    _calculateDataConsistency(history: HistoricalOffer[]): number {
        if (history.length < 2) {
            return 0; // Se abbiamo meno di 2 record, non possiamo calcolare la coerenza, quindi 0%
        }
        
        // Examine markup consistency
        const markups = history.map(h => h.markup).filter(m => m != null && !isNaN(m));
        
        if (markups.length < 2) {
            return 0; // Se non abbiamo abbastanza dati di markup, non possiamo calcolare la coerenza, quindi 0%
        }
        
        const mean = markups.reduce((sum, m) => sum + m, 0) / markups.length;
        const variance = markups.reduce((sum, m) => sum + Math.pow(m - mean, 2), 0) / markups.length;
        const stdDev = Math.sqrt(variance);
        
        // Calculate coefficient of variation (standardized measure of dispersion)
        const coefficientOfVariation = (stdDev / Math.abs(mean)) * 100;
        
        // Normalize: lower variation = higher consistency score
        // 0% variation = 100 score, 50%+ variation = 0 score
        const consistencyScore = Math.max(0, 100 - (coefficientOfVariation * 2));
        
        return consistencyScore;
    },
    
    // Database query methods
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
    
    /**
     * Fetch complete history of offers for a specific customer (regardless of product)
     * @param db Database connection
     * @param customerNr Customer number
     * @returns Array of historical offers
     */
    async _fetchCompleteCustomerHistory(db: any, customerNr: string): Promise<HistoricalOffer[]> {
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
            ORDER BY offer__encoding_date DESC
            LIMIT 50
        `).all([customerNr]);
    }
};
