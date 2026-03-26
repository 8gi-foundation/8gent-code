/**
 * Contract utility for assembling standard contract clauses.
 */
class ContractUtils {
  private static clauses = {
    payment: "Payment terms: {partyA} shall pay {partyB} ...",
    ip: "Intellectual property rights ...",
    confidentiality: "Confidentiality: ...",
    termination: "Termination: ...",
    liability: "Liability: ...",
    dispute: "Dispute resolution: ...",
  };

  /**
   * Retrieves the text for a specific contract clause.
   * @param type - The type of clause (e.g., 'payment', 'termination')
   * @returns The clause text
   */
  public static getClause(type: string): string {
    return ContractUtils.clauses[type];
  }

  /**
   * Assembles a full contract from specified clauses and party names.
   * @param clauses - Array of clause types to include
   * @param parties - Object with partyA and partyB names
   * @returns The assembled contract text
   */
  public static buildContract(clauses: string[], parties: { partyA: string; partyB: string }): string {
    return clauses
      .map(clause => ContractUtils.getClause(clause))
      .map(text => text.replace(/\{partyA\}/g, parties.partyA).replace(/\{partyB\}/g, parties.partyB))
      .join('\n\n');
  }

  /**
   * Lists all available clause types with descriptions.
   * @returns Array of clause type and description objects
   */
  public static listClauses(): { type: string; description: string }[] {
    return [
      { type: 'payment', description: 'Specifies payment terms and conditions' },
      { type: 'ip', description: 'Defines intellectual property ownership' },
      { type: 'confidentiality', description: 'Protects confidential information' },
      { type: 'termination', description: 'Outlines termination conditions' },
      { type: 'liability', description: 'Limits liability of parties' },
      { type: 'dispute', description: 'Details dispute resolution procedures' },
    ];
  }

  /**
   * Validates that a contract contains required clauses.
   * @param contract - Array of clause types included in the contract
   * @returns True if payment and termination clauses are present
   */
  public static validateContract(contract: string[]): boolean {
    return contract.includes('payment') && contract.includes('termination');
  }
}

export { ContractUtils };